import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { LIMITS } from '@ascendant/core'
import {
  assertAlive,
  assertEgressAllowed,
  assertSafeWritePath,
  assertWithinWriteCap,
  stripSecrets,
} from './guards.js'
import {
  SandboxError,
  type ExecOptions,
  type ExecResult,
  type FileMap,
  type Handle,
  type SandboxDriver,
  type SandboxSpec,
} from './types.js'

/**
 * The local driver: a temp directory plus a child process.
 *
 * This is **not** an isolation boundary and must never be presented as one. It exists
 * for two honest reasons:
 *
 * 1. The offline demo path (§16.3). When E2B credit is gone or the conference wifi is
 *    hostile, a run against the seeded repo still works.
 * 2. It is the only driver whose behaviour can be asserted in a unit test, so the
 *    shared guards in `guards.ts` — the write cap, the blocked paths, the egress
 *    checks, the wall clock — are covered by tests that actually execute them.
 *
 * Everything a hostile diff could do here, it could do to the machine running it.
 * `ASCENDANT_ALLOW_LOCAL_SANDBOX` must be set explicitly, so nobody reaches this
 * driver by accident on a deployed instance.
 */
export interface LocalDriverOptions {
  /** Root for temp workspaces. Defaults to the OS temp dir. */
  root?: string
  /** Overridable so tests do not need 10 minutes. */
  writeCapBytes?: number
  /** Escape hatch for tests; production requires the env var. */
  allow?: boolean
}

export function localDriver(opts: LocalDriverOptions = {}): SandboxDriver {
  const allowed = opts.allow ?? process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1'
  const writeCap = opts.writeCapBytes ?? LIMITS.SANDBOX_MAX_WRITTEN_BYTES
  const dirs = new Map<string, string>()

  const workspace = (h: Handle): string => {
    const dir = dirs.get(h.id)
    if (!dir) throw new SandboxError(`sandbox ${h.id} has been destroyed`, 'destroyed')
    return dir
  }

  return {
    id: 'local',

    async create(spec: SandboxSpec): Promise<Handle> {
      if (!allowed) {
        throw new SandboxError(
          'the local driver runs generated code on this machine with no isolation; set ASCENDANT_ALLOW_LOCAL_SANDBOX=1 to permit it',
          'unavailable',
        )
      }
      const base = opts.root ?? tmpdir()
      await mkdir(base, { recursive: true })
      const dir = await mkdtemp(join(base, 'ascendant-'))
      const now = Date.now()
      const h: Handle = {
        id: dir,
        driver: 'local',
        createdAt: now,
        deadlineAt: now + Math.min(spec.timeoutMs, LIMITS.SANDBOX_TIMEOUT_MS),
      }
      dirs.set(h.id, dir)
      return h
    },

    async writeFiles(h: Handle, files: FileMap): Promise<void> {
      assertAlive(h)
      const dir = workspace(h)
      assertWithinWriteCap(files, writeCap)

      for (const [path, content] of Object.entries(files)) {
        assertSafeWritePath(path)
        const target = resolve(dir, path)
        // Belt and braces: resolve() must not have escaped the workspace even if
        // assertSafeWritePath somehow let something through.
        if (!target.startsWith(resolve(dir))) {
          throw new SandboxError(`refusing a write that escapes the workspace: ${path}`, 'blocked_path')
        }
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
      }
    },

    async exec(h: Handle, cmd: string[], execOpts: ExecOptions = {}): Promise<ExecResult> {
      assertAlive(h)
      assertEgressAllowed(cmd)
      const dir = workspace(h)
      const [bin, ...args] = cmd
      if (!bin) throw new SandboxError('exec called with an empty command', 'unavailable')

      const budget = Math.max(0, h.deadlineAt - Date.now())
      const timeoutMs = Math.min(execOpts.timeoutMs ?? budget, budget)
      const startedAt = Date.now()

      // No secrets, and no inherited environment: the sandbox gets source code, never a
      // token (§12.4). PATH is the one thing a child needs to find its interpreter.
      //
      // Cast rather than an inline literal: Next augments NodeJS.ProcessEnv to make
      // NODE_ENV required, so an object literal here fails overload resolution in the
      // web app's compilation and collapses `child` to `never`. Deliberately NOT
      // satisfied by adding NODE_ENV — forcing a value would change how the repo under
      // test builds.
      const childEnv = {
        ...stripSecrets({}),
        PATH: process.env.PATH ?? '',
        CI: '1',
      } as unknown as NodeJS.ProcessEnv

      return new Promise<ExecResult>((resolvePromise) => {
        const child = spawn(bin, args, {
          cwd: execOpts.cwd ? resolve(dir, execOpts.cwd) : dir,
          env: childEnv,
          shell: false,
        })

        let stdout = ''
        let stderr = ''
        let timedOut = false
        const CAP = 256 * 1024

        child.stdout?.on('data', (d: Buffer) => {
          if (stdout.length < CAP) stdout += d.toString('utf8')
        })
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < CAP) stderr += d.toString('utf8')
        })

        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)

        const finish = (exitCode: number) => {
          clearTimeout(timer)
          resolvePromise({
            exitCode,
            stdout,
            stderr,
            timedOut,
            durationMs: Date.now() - startedAt,
          })
        }

        child.on('error', (err) => {
          stderr += `\n${err.message}`
          finish(127)
        })
        child.on('close', (codeOrNull) => finish(timedOut ? 124 : (codeOrNull ?? 0)))
      })
    },

    async readFile(h: Handle, path: string): Promise<string> {
      assertAlive(h)
      const dir = workspace(h)
      const target = resolve(dir, path)
      if (!target.startsWith(resolve(dir))) {
        throw new SandboxError(`refusing a read that escapes the workspace: ${path}`, 'blocked_path')
      }
      return readFile(target, 'utf8')
    },

    /** Idempotent: the workflow calls this in a `finally`, possibly twice. */
    async destroy(h: Handle): Promise<void> {
      const dir = dirs.get(h.id)
      if (!dir) return
      dirs.delete(h.id)
      await rm(dir, { recursive: true, force: true })
    },
  }
}
