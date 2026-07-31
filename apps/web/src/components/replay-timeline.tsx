'use client'

import { useEffect, useState } from 'react'
import type { AgentEventRow } from '@ascendant/db'
import { Timeline } from './timeline'
import { replaySchedule } from '@/lib/replay'

/**
 * The `DEMO_MODE=replay` timeline (§16.3).
 *
 * Reveals stored `agent_events` at their original relative pacing instead of printing
 * the finished run at once. The rows are real — they were written by a real execution
 * and read back out of Postgres — and the banner says exactly that, because a replay
 * presented as a live run would be a lie and presented honestly costs nothing.
 *
 * Rendering is delegated to the same `Timeline` used on the live path, so a replay
 * cannot drift from what the dashboard normally shows.
 */
export function ReplayTimeline({ rows }: { rows: AgentEventRow[] }) {
  const [shown, setShown] = useState(rows.length ? 1 : 0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing || rows.length === 0) return
    if (shown >= rows.length) return

    const steps = replaySchedule(rows)
    const start = Date.now()
    // One timer per remaining row rather than an interval: the gaps are uneven by
    // design, and that unevenness is the part of the run worth reproducing.
    const timers = steps
      .slice(shown)
      .map((s) =>
        setTimeout(
          () => setShown((n) => Math.max(n, s.index + 1)),
          Math.max(0, s.atMs - (steps[shown - 1]?.atMs ?? 0) - (Date.now() - start)),
        ),
      )
    return () => timers.forEach(clearTimeout)
    // `shown` is deliberately excluded: re-running on every reveal would restart the
    // schedule and stretch the replay indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rows])

  const done = shown >= rows.length

  return (
    <>
      <div className="row small dim" style={{ marginBottom: 8, gap: 10 }}>
        <span className="pill flag">replay</span>
        <span>
          {done
            ? `${rows.length} recorded steps, replayed at their original pacing`
            : `replaying step ${shown} of ${rows.length}…`}
        </span>
        <span style={{ flex: 1 }} />
        {!done && (
          <button type="button" className="linkish" onClick={() => setShown(rows.length)}>
            skip to end
          </button>
        )}
        {done && rows.length > 0 && (
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setShown(1)
              setPlaying(true)
            }}
          >
            replay again
          </button>
        )}
      </div>
      <Timeline rows={rows.slice(0, shown)} />
    </>
  )
}
