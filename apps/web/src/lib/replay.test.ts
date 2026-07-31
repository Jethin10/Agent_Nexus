import { describe, expect, it } from 'vitest'
import { DEFAULT_SPEED, replayDurationMs, replaySchedule } from './replay'

const at = (ms: number) => ({ at: new Date(1_700_000_000_000 + ms) })

describe('replaySchedule', () => {
  it('returns nothing for no rows', () => {
    expect(replaySchedule([])).toEqual([])
    expect(replayDurationMs([])).toBe(0)
  })

  it('starts the first row immediately', () => {
    const steps = replaySchedule([at(0), at(1_000)])
    expect(steps[0]).toEqual({ index: 0, atMs: 0 })
  })

  it('preserves the given order rather than re-sorting', () => {
    // agent_events has no sequence column, so the server's `order by at` is the only
    // ordering there is. Re-sorting here could disagree with what was rendered.
    const steps = replaySchedule([at(5_000), at(0), at(9_000)])
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2])
  })

  it('divides real gaps by the speed factor', () => {
    const steps = replaySchedule([at(0), at(8_000)], { speed: 8 })
    expect(steps[1]?.atMs).toBe(1_000)
  })

  it('compresses a single long gap so a sandbox wait is not dead air', () => {
    const steps = replaySchedule([at(0), at(600_000)], { speed: 1, maxGapMs: 2_500 })
    expect(steps[1]?.atMs).toBe(2_500)
  })

  it('keeps same-millisecond rows visibly distinct', () => {
    // A batch insert can share a timestamp; revealing them together looks like a glitch.
    const steps = replaySchedule([at(0), at(0), at(0)])
    expect(steps[1]?.atMs).toBeGreaterThan(0)
    expect(steps[2]?.atMs).toBeGreaterThan(steps[1]?.atMs ?? 0)
  })

  it('preserves the relative shape of a burst followed by a wait', () => {
    // The run's texture is the point: fast router retries, then a slow QA wait.
    const steps = replaySchedule([at(0), at(200), at(400), at(30_000)], { speed: 4 })
    const gaps = steps.slice(1).map((s, i) => s.atMs - (steps[i]?.atMs ?? 0))
    expect(gaps[0]).toBeLessThan(gaps[2] ?? 0)
    expect(gaps[1]).toBeLessThan(gaps[2] ?? 0)
  })

  it('is monotonic across a realistic run', () => {
    const rows = [0, 120, 340, 900, 2_400, 61_000, 61_800].map(at)
    const steps = replaySchedule(rows)
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]?.atMs).toBeGreaterThan(steps[i - 1]?.atMs ?? 0)
    }
    expect(replayDurationMs(steps)).toBe(steps[steps.length - 1]?.atMs)
  })

  it('falls back to the default speed for nonsense input', () => {
    const bad = replaySchedule([at(0), at(8_000)], { speed: 0 })
    const good = replaySchedule([at(0), at(8_000)], { speed: DEFAULT_SPEED })
    expect(bad).toEqual(good)
  })

  it('never schedules a negative time when timestamps go backwards', () => {
    const steps = replaySchedule([at(5_000), at(0)])
    expect(steps.every((s) => s.atMs >= 0)).toBe(true)
  })
})
