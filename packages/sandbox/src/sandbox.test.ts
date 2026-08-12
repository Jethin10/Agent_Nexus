import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  EGRESS_ALLOWLIST,
  SandboxError,
  assertEgressAllowed,
  assertSafeWritePath,
  assertWithinWriteCap,
  inSandbox,
  localDriver,
  selectDriver,
  shellQuote,
  stripSecrets,
  type Handle,
} from './index.js'

const ROOT = join(tmpdir(), 'ascendant-sandbox-tests')
const driver = localDriver({ root: ROOT, allow: true })

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const handle = (over: Partial<Handle> = {}): Handle => ({
  id: 'h',
  driver: 'local',
  createdAt: Date.now(),
  deadlineAt: Date.now() + 60_000,
  ...over,
})

describe('assertSafeWritePath — the sandbox cannot write outside its workspace', () => {
  it('allows an ordinary relative path', () => {
    expect(() => assertSafeWritePath('src/session.ts')).not.toThrow()
  })

  it('refuses an absolute path, POSIX or Windows', () => {
    expect(() => assertSafeWritePath('/etc/passwd')).toThrow(SandboxError)
    expect(() => assertSafeWritePath('C:/Windows/System32/x')).toThrow(SandboxError)
  })

  it('refuses traversal', () => {
    expect(() => assertSafeWritePath('../../.ssh/authorized_keys')).toThrow(/traversing/)
    expect(() => assertSafeWritePath('src/../../x')).toThrow(/traversing/)
  })

  it('refuses the deterministically blocked paths — layer 3, not persuasion', () => {
    for (const p of ['.github/workflows/ci.yml', '.env', '.env.production', 'pnpm-lock.yaml']) {
      expect(() => assertSafeWritePath(p), p).toThrow(SandboxError)
    }
  })

  it('normalizes backslashes before judging', () => {
    expect(() => assertSafeWritePath('.github\\workflows\\ci.yml')).toThrow(SandboxError)
  })
})

describe('assertWithinWriteCap', () => {
  it('returns the byte total when under the cap', () => {
    expect(assertWithinWriteCap({ 'a.ts': 'hello' }, 1_000)).toBe(5)
  })

  it('refuses before the write, not after', () => {
    expect(() => assertWithinWriteCap({ 'a.ts': 'x'.repeat(2_000) }, 1_000)).toThrow(/write cap|refusing/)
  })

  it('counts every file, not just the largest', () => {
    expect(() => assertWithinWriteCap({ a: 'x'.repeat(600), b: 'y'.repeat(600) }, 1_000)).toThrow(
      SandboxError,
    )
  })
})

describe('assertEgressAllowed — package registry only', () => {
  it('allows the registries on the allowlist', () => {
    expect(EGRESS_ALLOWLIST).toContain('registry.npmjs.org')
    expect(() => assertEgressAllowed(['npm', 'install', '--registry', 'https://registry.npmjs.org'])).not.toThrow()
  })

  it('allows a subdomain of an allowlisted host', () => {
    expect(() => assertEgressAllowed(['curl', 'https://cdn.registry.npmjs.org/x'])).not.toThrow()
  })

  it('refuses anything else', () => {
    expect(() => assertEgressAllowed(['curl', 'https://evil.example.com/x'])).toThrow(/egress allowlist/)
  })

  it('refuses reaching this project’s own infrastructure', () => {
    // §12.4: no access to Neon, Inngest, or the GitHub API from inside the sandbox.
    for (const host of ['https://ep-x.neon.tech', 'https://api.inngest.com', 'https://api.github.com']) {
      expect(() => assertEgressAllowed(['curl', host]), host).toThrow(SandboxError)
    }
  })

  it('allows a command with no host in it at all', () => {
    expect(() => assertEgressAllowed(['pnpm', 'test'])).not.toThrow()
  })
})

describe('stripSecrets — the sandbox gets source code, never a token', () => {
  it('drops anything that looks like a credential', () => {
    const safe = stripSecrets({
      GROQ_API_KEY: 'gk',
      DATABASE_URL: 'postgres://x',
      GITHUB_TOKEN: 't',
      MY_SECRET: 's',
      ADMIN_PASSWORD: 'p',
      CI: '1',
      NODE_ENV: 'test',
    })
    expect(safe).toEqual({ CI: '1', NODE_ENV: 'test' })
  })

  it('returns an empty object for an empty environment', () => {
    expect(stripSecrets()).toEqual({})
  })
})

describe('shellQuote — E2B takes a shell string, so argv must be quoted', () => {
  it('leaves safe tokens alone', () => {
    expect(shellQuote('pnpm')).toBe('pnpm')
    expect(shellQuote('src/a.test.ts')).toBe('src/a.test.ts')
  })

  it('quotes a token containing a command separator', () => {
    expect(shellQuote('a; rm -rf /')).toBe("'a; rm -rf /'")
  })

  it('escapes an embedded single quote', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('localDriver — refuses to run unless explicitly permitted', () => {
  it('throws when neither the option nor the env var is set', async () => {
    const guarded = localDriver({ root: ROOT, allow: false })
    delete process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX
    await expect(guarded.create({ image: 'x', timeoutMs: 1_000 })).rejects.toThrow(/no isolation/)
  })
})

describe('localDriver — filesystem behaviour', () => {
  it('writes, execs and reads back', async () => {
    const h = await driver.create({ image: 'node', timeoutMs: 30_000 })
    try {
      await driver.writeFiles(h, { 'src/a.txt': 'hello' })
      expect(await driver.readFile(h, 'src/a.txt')).toBe('hello')

      const res = await driver.exec(h, [process.execPath, '-e', 'console.log("ran")'])
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe('ran')
      expect(res.timedOut).toBe(false)
    } finally {
      await driver.destroy(h)
    }
  })

  it('reports a non-zero exit as data rather than throwing', async () => {
    // A failing test suite is the QA agent's input, not a driver error.
    const h = await driver.create({ image: 'node', timeoutMs: 30_000 })
    try {
      const res = await driver.exec(h, [process.execPath, '-e', 'process.exit(3)'])
      expect(res.exitCode).toBe(3)
    } finally {
      await driver.destroy(h)
    }
  })

  it('kills a runaway command on the wall clock', async () => {
    const h = await driver.create({ image: 'node', timeoutMs: 30_000 })
    try {
      const res = await driver.exec(h, [process.execPath, '-e', 'setInterval(() => {}, 10)'], {
        timeoutMs: 400,
      })
      expect(res.timedOut).toBe(true)
      expect(res.exitCode).toBe(124)
    } finally {
      await driver.destroy(h)
    }
  })

  it('enforces the blocked paths through the driver, not just the guard', async () => {
    const h = await driver.create({ image: 'node', timeoutMs: 10_000 })
    try {
      await expect(driver.writeFiles(h, { '.env': 'SECRET=1' })).rejects.toThrow(SandboxError)
      await expect(driver.writeFiles(h, { '../escape.txt': 'x' })).rejects.toThrow(SandboxError)
    } finally {
      await driver.destroy(h)
    }
  })

  it('refuses work past its deadline', async () => {
    const h = await driver.create({ image: 'node', timeoutMs: 10_000 })
    try {
      const expired = { ...h, deadlineAt: Date.now() - 1 }
      await expect(driver.writeFiles(expired, { 'a.txt': 'x' })).rejects.toThrow(/deadline/)
    } finally {
      await driver.destroy(h)
    }
  })

  it('caps the wall clock at the §12.4 ceiling however long the caller asks for', async () => {
    const h = await driver.create({ image: 'node', timeoutMs: 60 * 60 * 1000 })
    try {
      expect(h.deadlineAt - h.createdAt).toBeLessThanOrEqual(10 * 60 * 1000)
    } finally {
      await driver.destroy(h)
    }
  })

  it('is destroyed idempotently, since the workflow calls destroy in a finally', async () => {
    const h = await driver.create({ image: 'node', timeoutMs: 10_000 })
    await driver.destroy(h)
    await expect(driver.destroy(h)).resolves.toBeUndefined()
    await expect(driver.writeFiles(h, { 'a.txt': 'x' })).rejects.toThrow(/destroyed/)
  })

  it('does not forward this process’s secrets into the child', async () => {
    process.env.ASCENDANT_TEST_SECRET_KEY = 'leaked'
    const h = await driver.create({ image: 'node', timeoutMs: 30_000 })
    try {
      const res = await driver.exec(h, [
        process.execPath,
        '-e',
        'console.log(process.env.ASCENDANT_TEST_SECRET_KEY ?? "absent")',
      ])
      expect(res.stdout.trim()).toBe('absent')
    } finally {
      await driver.destroy(h)
      delete process.env.ASCENDANT_TEST_SECRET_KEY
    }
  })
})

describe('inSandbox — always destroyed', () => {
  it('destroys on the happy path', async () => {
    const seen: string[] = []
    const h = await inSandbox(driver, { image: 'node', timeoutMs: 10_000 }, async (handleIn) => {
      seen.push(handleIn.id)
      return handleIn
    })
    await expect(driver.writeFiles(h, { 'a.txt': 'x' })).rejects.toThrow(/destroyed/)
    expect(seen).toHaveLength(1)
  })

  it('destroys even when the body throws — a leaked microVM burns the demo credit', async () => {
    let leaked: Handle | undefined
    await expect(
      inSandbox(driver, { image: 'node', timeoutMs: 10_000 }, async (h) => {
        leaked = h
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(leaked).toBeDefined()
    await expect(driver.writeFiles(leaked!, { 'a.txt': 'x' })).rejects.toThrow(/destroyed/)
  })
})

describe('selectDriver — E2B primary, Actions fallback, local last', () => {
  it('prefers E2B when a key is present', () => {
    expect(selectDriver({ E2B_API_KEY: 'k' }).id).toBe('e2b')
  })

  it('falls back to Actions when E2B credit is gone', () => {
    expect(
      selectDriver({
        GITHUB_TOKEN: 't',
        GITHUB_OWNER: 'acme',
        GITHUB_REPO: 'api',
        ALLOW_ACTIONS: true,
      }).id,
    ).toBe('actions')
  })

  it('reaches local only when explicitly allowed', () => {
    expect(selectDriver({ ALLOW_LOCAL: true }).id).toBe('local')
  })

  it('throws rather than silently running generated code with no isolation', () => {
    delete process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX
    expect(() => selectDriver({})).toThrow(SandboxError)
  })
})
