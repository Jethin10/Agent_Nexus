import { describe, expect, it } from 'vitest'
import { TRIAGE_OUTCOMES, TriageOutcome } from './triage.js'

/**
 * The case tolerance here is load-bearing rather than cosmetic. Free-tier models
 * routinely answer `"reject"`, and because the router allows exactly one repair retry
 * against a 1,000-request/day ceiling, spending that retry on capitalisation drove the
 * whole cascade to `no_capacity` — turning a correct REJECT into an ESCALATE. These
 * tests pin the boundary: case is forgiven, meaning is not.
 */
describe('TriageOutcome', () => {
  it('accepts the canonical uppercase spelling unchanged', () => {
    for (const o of TRIAGE_OUTCOMES) {
      expect(TriageOutcome.parse(o)).toBe(o)
    }
  })

  it('normalises the lowercase spelling models actually emit', () => {
    expect(TriageOutcome.parse('reject')).toBe('REJECT')
    expect(TriageOutcome.parse('accept')).toBe('ACCEPT')
    expect(TriageOutcome.parse('escalate')).toBe('ESCALATE')
  })

  it('normalises mixed case and surrounding whitespace', () => {
    expect(TriageOutcome.parse('Defer')).toBe('DEFER')
    expect(TriageOutcome.parse('  merge\n')).toBe('MERGE')
  })

  it('still rejects an unrecognised word, which is a reasoning failure', () => {
    // Worth a repair retry, unlike capitalisation: the model chose a non-outcome.
    expect(TriageOutcome.safeParse('MAYBE').success).toBe(false)
    expect(TriageOutcome.safeParse('approve').success).toBe(false)
    expect(TriageOutcome.safeParse('').success).toBe(false)
  })

  it('rejects non-string input rather than coercing it', () => {
    expect(TriageOutcome.safeParse(null).success).toBe(false)
    expect(TriageOutcome.safeParse(2).success).toBe(false)
    expect(TriageOutcome.safeParse(['REJECT']).success).toBe(false)
  })

  it('exposes all five outcomes, four of which are refusals', () => {
    expect(TRIAGE_OUTCOMES).toHaveLength(5)
    expect(TRIAGE_OUTCOMES.filter((o) => o !== 'ACCEPT')).toHaveLength(4)
  })
})
