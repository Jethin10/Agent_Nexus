import { LIMITS } from '@ascendant/core'
import {
  assertAlive,
  assertEgressAllowed,
  assertSafeWritePath,
  assertWithinWriteCap,
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
 * Fallback driver: GitHub Actions via `workflow_dispatch`, polled for completion.
 *
 * Slower than E2B (~2 min queue) but **free and unlimited on public repositories**
 * with standard runners — which makes the demo repo being public both a cost and a
 * reliability decision. This driver exists so that an E2B outage or an exhausted
 * credit degrades the pipeline to *slower*, not *broken* (§14.4).
 *
 * The shape differs from E2B in one important way: Actions is batch, not interactive.
 * There is no way to exec twice against the same live machine. So the driver buffers
 * writes and commands, dispatches one workflow run that performs all of them, and
 * reads results back from the run's output. `exec` therefore blocks on a poll rather
 * than returning promptly, and the caller sees the same interface either way.
 */
export interface ActionsDriverOptions {
  /** Installation token, minted per-run and expiring in 1 hour (§15.4). */
  token: string
  owner: string
  repo: string
  /** Workflow filename, e.g. `ascendant-sandbox.yml`. */
  workflow: string
  ref?: string
  fetcher?: typeof fetch
  /** Poll interval. Actions queue latency dominates, so this is coarse on purpose. */
  pollMs?: number
}

interface PendingRun {
  files: FileMap
  bytes: number
}

const API = 'https://api.github.com'

export function actionsDriver(opts: ActionsDriverOptions): SandboxDriver {
  const fetcher = opts.fetcher ?? fetch
  const pending = new Map<string, PendingRun>()

  const headers = () => ({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  })

  const state = (h: Handle): PendingRun => {
    const s = pending.get(h.id)
    if (!s) throw new SandboxError(`sandbox ${h.id} has been destroyed`, 'destroyed')
    return s
  }

  return {
    id: 'actions',

    async create(spec: SandboxSpec): Promise<Handle> {
      if (!opts.token) throw new SandboxError('no installation token for the Actions driver', 'unavailable')
      const now = Date.now()
      const h: Handle = {
        id: `actions-${now}-${Math.random().toString(36).slice(2, 8)}`,
        driver: 'actions',
        createdAt: now,
        deadlineAt: now + Math.min(spec.timeoutMs, LIMITS.SANDBOX_TIMEOUT_MS),
      }
      pending.set(h.id, { files: {}, bytes: 0 })
      return h
    },

    /** Buffered: Actions has no live filesystem to write into before dispatch. */
    async writeFiles(h: Handle, files: FileMap): Promise<void> {
      assertAlive(h)
      const s = state(h)
      const merged = { ...s.files, ...files }
      s.bytes = assertWithinWriteCap(merged, LIMITS.SANDBOX_MAX_WRITTEN_BYTES)
      for (const path of Object.keys(files)) assertSafeWritePath(path)
      s.files = merged
    },

    async exec(h: Handle, cmd: string[], execOpts: ExecOptions = {}): Promise<ExecResult> {
      assertAlive(h)
      assertEgressAllowed(cmd)
      const s = state(h)
      const startedAt = Date.now()

      const budget = Math.max(0, h.deadlineAt - Date.now())
      const timeoutMs = Math.min(execOpts.timeoutMs ?? budget, budget)

      const encodedFiles = Buffer.from(JSON.stringify(s.files), 'utf8').toString('base64')
      if (encodedFiles.length > 60_000) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `actions payload is ${encodedFiles.length} bytes; refusing to truncate the 60000-byte workflow input`,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        }
      }

      const dispatch = await fetcher(
        `${API}/repos/${opts.owner}/${opts.repo}/actions/workflows/${opts.workflow}/dispatches`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            ref: opts.ref ?? 'main',
            inputs: {
              handle: h.id,
              // Inputs are capped at 64KB by GitHub, so files travel base64-encoded
              // and the workflow decodes them into the checkout.
              files: encodedFiles,
              command: JSON.stringify(cmd),
              cwd: execOpts.cwd ?? '.',
            },
          }),
        },
      )

      if (!dispatch.ok) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `actions dispatch failed: ${dispatch.status} ${await dispatch.text()}`.slice(0, 2_000),
          timedOut: false,
          durationMs: Date.now() - startedAt,
        }
      }

      const result = await pollRun(fetcher, opts, h.id, timeoutMs, opts.pollMs ?? 5_000)
      return { ...result, durationMs: Date.now() - startedAt }
    },

    async readFile(h: Handle, path: string): Promise<string> {
      assertAlive(h)
      const s = state(h)
      const content = s.files[path]
      if (content === undefined) {
        throw new SandboxError(
          `the Actions driver cannot read ${path} back: it is batch, so only written files are readable`,
          'unavailable',
        )
      }
      return content
    },

    async destroy(h: Handle): Promise<void> {
      pending.delete(h.id)
    },
  }
}

interface RunSummary {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Finds the dispatched run by the handle we passed as an input, then polls it to
 * completion. Matching on the handle rather than "the most recent run" matters:
 * Inngest allows five concurrent steps, so two sandboxes can be dispatched seconds
 * apart and picking the newest run would attribute one ticket's test results to
 * another.
 */
async function pollRun(
  fetcher: typeof fetch,
  opts: ActionsDriverOptions,
  handle: string,
  timeoutMs: number,
  pollMs: number,
): Promise<RunSummary> {
  const deadline = Date.now() + timeoutMs
  const base = `${API}/repos/${opts.owner}/${opts.repo}/actions`
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
  }

  let runId: number | undefined

  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))

    if (runId === undefined) {
      const res = await fetcher(`${base}/runs?per_page=20`, { headers })
      if (res.status === 403) {
        // Secondary rate limit. §14.3: honour Retry-After rather than hammering.
        const retry = Number(res.headers.get('retry-after') ?? '30')
        await sleep(Math.min(retry * 1000, Math.max(0, deadline - Date.now())))
        continue
      }
      if (!res.ok) continue
      const body = (await res.json()) as { workflow_runs?: { id: number; name?: string }[] }
      runId = body.workflow_runs?.find((r) => (r.name ?? '').includes(handle))?.id
      if (runId === undefined) continue
    }

    const res = await fetcher(`${base}/runs/${runId}`, { headers })
    if (!res.ok) continue
    const run = (await res.json()) as { status?: string; conclusion?: string | null }
    if (run.status !== 'completed') continue

    const logs = await fetchLogs(fetcher, base, runId, headers)
    return {
      exitCode: run.conclusion === 'success' ? 0 : 1,
      stdout: logs,
      stderr: run.conclusion === 'success' ? '' : `workflow concluded ${run.conclusion}`,
      timedOut: false,
    }
  }

  return {
    exitCode: 124,
    stdout: '',
    stderr: `the Actions run for ${handle} did not complete within ${timeoutMs}ms`,
    timedOut: true,
  }
}

/** Best-effort log retrieval. A missing log is not a test failure, so it degrades. */
async function fetchLogs(
  fetcher: typeof fetch,
  base: string,
  runId: number,
  headers: Record<string, string>,
): Promise<string> {
  try {
    const res = await fetcher(`${base}/runs/${runId}/logs`, { headers, redirect: 'follow' })
    if (!res.ok) return `(logs unavailable: ${res.status})`
    return (await res.text()).slice(0, 200_000)
  } catch (err) {
    return `(logs unavailable: ${err instanceof Error ? err.message : 'unknown'})`
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
