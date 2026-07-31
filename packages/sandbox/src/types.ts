import { LIMITS } from '@ascendant/core'

/**
 * §12.4 — the sandbox layer. Agent-generated code never runs on Vercel, never runs
 * on your laptop, and never runs with network access to your own infrastructure.
 *
 * The rules below are enforced **by the driver, not by prompt**. That distinction is
 * the entire security argument: an agent that gets prompt-injected inside the sandbox
 * can at worst write a bad diff, which then has to survive the Reviewer, QA, and a
 * human PR review.
 *
 * > The sandbox produces a diff; it never has the credentials to publish one.
 */
export interface SandboxSpec {
  image: string
  timeoutMs: number
  /** Never populated with a real secret. Present so a caller must pass `{}`. */
  env?: Record<string, string>
}

export interface Handle {
  id: string
  driver: DriverId
  createdAt: number
  /** Wall-clock deadline. `exec` refuses past it rather than trusting the provider. */
  deadlineAt: number
}

export type DriverId = 'e2b' | 'actions' | 'local'

export type FileMap = Record<string, string>

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when the driver killed it on the wall clock rather than it exiting. */
  timedOut: boolean
  durationMs: number
}

export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
}

/** One interface, three drivers. Swapping to Modal later is a ~150-line file (§12.4). */
export interface SandboxDriver {
  readonly id: DriverId
  create(spec: SandboxSpec): Promise<Handle>
  writeFiles(h: Handle, files: FileMap): Promise<void>
  exec(h: Handle, cmd: string[], opts?: ExecOptions): Promise<ExecResult>
  readFile(h: Handle, path: string): Promise<string>
  destroy(h: Handle): Promise<void>
}

/** Thrown when the driver itself refuses, as opposed to the command failing. */
export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'timeout'
      | 'write_cap'
      | 'blocked_path'
      | 'egress_denied'
      | 'unavailable'
      | 'destroyed',
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

/**
 * The egress allowlist: package registry only. **No access to Neon, Inngest, or the
 * GitHub API.** The git push happens outside the sandbox, from the workflow, after
 * the diff is read back out.
 */
export const EGRESS_ALLOWLIST: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
]

export const DEFAULT_SPEC: SandboxSpec = {
  image: 'ascendant-node20',
  timeoutMs: LIMITS.SANDBOX_TIMEOUT_MS,
  env: {},
}
