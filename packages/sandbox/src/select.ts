import { DEFAULT_SPEC, SandboxError, type ExecResult, type SandboxDriver } from './types.js'
import { actionsDriver } from './actions.js'
import { e2bDriver } from './e2b.js'
import { localDriver } from './local.js'

/**
 * Driver selection. E2B primary, Actions fallback, local only when explicitly
 * permitted — so an E2B outage or an exhausted credit degrades the pipeline to
 * slower rather than broken (§14.4).
 */
export interface SelectOptions {
  E2B_API_KEY?: string | undefined
  E2B_TEMPLATE_ID?: string | undefined
  /** Installation token, minted per-run, 1-hour expiry (§15.4). */
  GITHUB_TOKEN?: string | undefined
  GITHUB_OWNER?: string | undefined
  GITHUB_REPO?: string | undefined
  ACTIONS_WORKFLOW?: string | undefined
  /** Experimental fallback; disabled unless a repository-installed workflow is proven. */
  ALLOW_ACTIONS?: boolean
  ALLOW_LOCAL?: boolean
}

export function selectDriver(opts: SelectOptions): SandboxDriver {
  if (opts.E2B_API_KEY) {
    return e2bDriver({
      apiKey: opts.E2B_API_KEY,
      ...(opts.E2B_TEMPLATE_ID ? { templateId: opts.E2B_TEMPLATE_ID } : {}),
    })
  }

  if (opts.ALLOW_ACTIONS && opts.GITHUB_TOKEN && opts.GITHUB_OWNER && opts.GITHUB_REPO) {
    return actionsDriver({
      token: opts.GITHUB_TOKEN,
      owner: opts.GITHUB_OWNER,
      repo: opts.GITHUB_REPO,
      workflow: opts.ACTIONS_WORKFLOW ?? 'ascendant-sandbox.yml',
    })
  }

  if (opts.ALLOW_LOCAL || process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1') {
    return localDriver({ allow: true })
  }

  throw new SandboxError(
    'no sandbox driver is available: set E2B_API_KEY, or GitHub Actions credentials, or ASCENDANT_ALLOW_LOCAL_SANDBOX=1',
    'unavailable',
  )
}

export interface TestRunResult {
  baseline: ExecResult
  after: ExecResult
  /** Re-runs of a failing suite, for flake detection. §14.3: 2 of 3 passes = flaky. */
  reruns: ExecResult[]
  /** The diff as read back out of the sandbox — the only thing that leaves it. */
  diff: string
}

export interface RunTestsInput {
  driver: SandboxDriver
  /** Repo files to seed, plus the Coder's diff already applied to them. */
  files: Record<string, string>
  /** Same files WITHOUT the diff, for the baseline run. */
  baselineFiles: Record<string, string>
  /** e.g. ['pnpm', 'test']. */
  testCommand: string[]
  installCommand?: string[]
  timeoutMs?: number
  rerunOnFailure?: number
}

/**
 * Baseline, then the diff, then re-runs on failure.
 *
 * The baseline run is the load-bearing part (§14.3): a repo with a pre-existing
 * failure would otherwise make every diff look like a regression, and the Coder would
 * spend its two retries chasing a bug it did not introduce.
 *
 * Two sandboxes rather than one, and the baseline is destroyed before the diff runs:
 * a hostile diff that mutates the test harness could otherwise poison the baseline it
 * is being compared against.
 */
export async function runTests(input: RunTestsInput): Promise<TestRunResult> {
  const spec = { ...DEFAULT_SPEC, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }
  const install = input.installCommand ?? ['pnpm', 'install', '--frozen-lockfile', '--offline']

  const baseline = await inSandbox(input.driver, spec, async (h) => {
    await input.driver.writeFiles(h, input.baselineFiles)
    await input.driver.exec(h, install)
    return input.driver.exec(h, input.testCommand)
  })

  return inSandbox(input.driver, spec, async (h) => {
    await input.driver.writeFiles(h, input.files)
    await input.driver.exec(h, install)
    const after = await input.driver.exec(h, input.testCommand)

    const reruns: ExecResult[] = []
    if (after.exitCode !== 0 && !after.timedOut) {
      const n = input.rerunOnFailure ?? 2
      for (let i = 0; i < n; i += 1) reruns.push(await input.driver.exec(h, input.testCommand))
    }

    return { baseline, after, reruns, diff: '' }
  })
}

/**
 * Always destroyed, in a `finally` (§12.4). A leaked microVM burns the one-time E2B
 * credit for up to an hour, and the credit is what the demo runs on.
 */
export async function inSandbox<T>(
  driver: SandboxDriver,
  spec: Parameters<SandboxDriver['create']>[0],
  fn: (h: Awaited<ReturnType<SandboxDriver['create']>>) => Promise<T>,
): Promise<T> {
  const h = await driver.create(spec)
  try {
    return await fn(h)
  } finally {
    await driver.destroy(h)
  }
}
