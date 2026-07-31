import type { AgentEventRow } from '@ascendant/db'

/**
 * §16.3 insurance item 3 — `DEMO_MODE=replay`.
 *
 * Serves stored `agent_events` at their original relative timing. This is **not** a
 * simulation: every row was written by a real run, and the only thing reconstructed is
 * the pacing between them, from the `at` column those rows already carry. Saying so out
 * loud is part of the deal — conference wifi is a legitimate reason to replay, and
 * honesty about it costs nothing.
 *
 * The timing logic lives here as a pure function so it can be tested without a browser
 * and without a database: given rows, it returns when each should appear.
 */

/** A real run's gaps can be minutes; a demo has four. */
export const DEFAULT_SPEED = 8

/** Never sit on a blank screen waiting for the first row. */
const MAX_INITIAL_DELAY_MS = 400

/** A single gap longer than this is compressed — a 3-minute sandbox wait is dead air. */
const MAX_GAP_MS = 2_500

export interface ReplayStep {
  /** Index into the original row array. */
  index: number
  /** Milliseconds from the start of the replay until this row should appear. */
  atMs: number
}

export interface ReplayOptions {
  /** Wall-clock divisor. 1 = true original timing. */
  speed?: number
  /** Cap on any single inter-row gap, after speed is applied. */
  maxGapMs?: number
}

/**
 * Turns stored rows into a reveal schedule.
 *
 * Two properties matter and both come from the data rather than from a constant:
 *
 * 1. **Order is the stored order.** `agent_events` has no sequence column — the
 *    timeline orders purely by `at` — so the schedule preserves the array it was given
 *    rather than re-sorting and risking a different answer than the server rendered.
 * 2. **Gaps are real, then compressed.** The relative shape of the run is what makes a
 *    replay legible: a fast burst of router attempts followed by a long QA wait should
 *    still *look* like that. So each gap is divided by `speed` and only then clamped,
 *    which preserves ordering of gap sizes up to the clamp.
 */
export function replaySchedule(
  rows: readonly Pick<AgentEventRow, 'at'>[],
  opts: ReplayOptions = {},
): ReplayStep[] {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : DEFAULT_SPEED
  const maxGap = opts.maxGapMs ?? MAX_GAP_MS

  const steps: ReplayStep[] = []
  let elapsed = 0

  for (const [index, row] of rows.entries()) {
    if (index === 0) {
      steps.push({ index, atMs: 0 })
      continue
    }
    const prev = rows[index - 1]
    const rawGap = Math.max(0, row.at.getTime() - (prev?.at.getTime() ?? row.at.getTime()))
    const scaled = Math.min(rawGap / speed, maxGap)
    // A floor keeps rows written in the same millisecond — a batch flush — from all
    // appearing at once, which would look like a rendering glitch rather than a run.
    elapsed += Math.max(scaled, 60)
    steps.push({ index, atMs: Math.round(elapsed) })
  }

  const first = steps[0]
  if (first) first.atMs = Math.min(first.atMs, MAX_INITIAL_DELAY_MS)
  return steps
}

/** Total wall-clock length of a replay, for the "replaying — Ns" label. */
export function replayDurationMs(steps: readonly ReplayStep[]): number {
  return steps.length ? (steps[steps.length - 1]?.atMs ?? 0) : 0
}
