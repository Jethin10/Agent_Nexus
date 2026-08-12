import { Sandbox } from 'e2b'
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
 * Primary driver: E2B. Firecracker microVM per sandbox, so a hostile `rm -rf /` or a
 * fork bomb costs a container rather than a machine.
 *
 * The SDK is a pinned runtime dependency. A configured E2B key must never reach a
 * deployment that only discovers at QA time that the isolation SDK was omitted.
 *
 * Config per §12.4: 2 vCPU, 2 GB RAM, 10-minute hard timeout, destroyed in a
 * `finally`. None of E2B's own limits bind here — 20 concurrent sandboxes and a
 * 1-hour session ceiling against a ~4-minute QA run and Inngest's 5 concurrent steps.
 */
export interface E2bDriverOptions {
  apiKey: string
  /** Optional pre-baked template with the target repository's toolchain installed. */
  templateId?: string
}

type E2bSandbox = Awaited<ReturnType<typeof Sandbox.create>>
const WORKSPACE = '/home/user/ascendant-workspace'

export function e2bDriver(opts: E2bDriverOptions): SandboxDriver {
  const sandboxes = new Map<string, E2bSandbox>()

  const get = (h: Handle): E2bSandbox => {
    const s = sandboxes.get(h.id)
    if (!s) throw new SandboxError(`sandbox ${h.id} has been destroyed`, 'destroyed')
    return s
  }

  return {
    id: 'e2b',

    async create(spec: SandboxSpec): Promise<Handle> {
      if (!opts.apiKey) throw new SandboxError('E2B_API_KEY is not set', 'unavailable')
      const timeoutMs = Math.min(spec.timeoutMs, LIMITS.SANDBOX_TIMEOUT_MS)

      const sandbox = await Sandbox.create({
        apiKey: opts.apiKey,
        ...(opts.templateId ? { template: opts.templateId } : {}),
        timeoutMs,
        // No secrets mounted, ever. stripSecrets is belt and braces on top of the
        // caller passing `{}` — the sandbox gets source code, never a token.
        envs: stripSecrets(spec.env),
      })

      await sandbox.commands.run(`mkdir -p ${shellQuote(WORKSPACE)}`, { timeoutMs: 10_000, envs: {} })

      const now = Date.now()
      const h: Handle = {
        id: sandbox.sandboxId,
        driver: 'e2b',
        createdAt: now,
        deadlineAt: now + timeoutMs,
      }
      sandboxes.set(h.id, sandbox)
      return h
    },

    async writeFiles(h: Handle, files: FileMap): Promise<void> {
      assertAlive(h)
      assertWithinWriteCap(files, LIMITS.SANDBOX_MAX_WRITTEN_BYTES)
      const sandbox = get(h)
      for (const [path, content] of Object.entries(files)) {
        assertSafeWritePath(path)
        await sandbox.files.write(`${WORKSPACE}/${path}`, content)
      }
    },

    async exec(h: Handle, cmd: string[], execOpts: ExecOptions = {}): Promise<ExecResult> {
      assertAlive(h)
      assertEgressAllowed(cmd)
      const sandbox = get(h)

      const budget = Math.max(0, h.deadlineAt - Date.now())
      const timeoutMs = Math.min(execOpts.timeoutMs ?? budget, budget)
      const startedAt = Date.now()

      /**
       * Arguments are quoted here because E2B's `commands.run` takes a shell string
       * rather than an argv array. A generated test name containing a `;` would
       * otherwise be a command injection into our own sandbox — which costs only a
       * microVM, but would still corrupt the QA result the pipeline reasons about.
       */
      const line = cmd.map(shellQuote).join(' ')

      try {
        const res = await sandbox.commands.run(line, {
          cwd: execOpts.cwd ? `${WORKSPACE}/${execOpts.cwd.replace(/^\.\/?/, '')}` : WORKSPACE,
          timeoutMs,
          envs: {},
        })
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        }
      } catch (err) {
        // A non-zero exit arrives as a throw in the E2B SDK. That is a test failure,
        // which is data the QA agent needs — not a driver error to propagate.
        const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string }
        const durationMs = Date.now() - startedAt
        const timedOut = durationMs >= timeoutMs
        return {
          exitCode: e.exitCode ?? (timedOut ? 124 : 1),
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message ?? 'e2b command failed',
          timedOut,
          durationMs,
        }
      }
    },

    async readFile(h: Handle, path: string): Promise<string> {
      assertAlive(h)
      assertSafeWritePath(path)
      return get(h).files.read(`${WORKSPACE}/${path}`)
    },

    /** Idempotent: the workflow calls this in a `finally`, possibly twice. */
    async destroy(h: Handle): Promise<void> {
      const sandbox = sandboxes.get(h.id)
      if (!sandbox) return
      sandboxes.delete(h.id)
      try {
        await sandbox.kill()
      } catch {
        // A sandbox that already expired on its own wall clock is the desired state.
      }
    },
  }
}

/** POSIX single-quote quoting. `'` becomes `'\''`. */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
