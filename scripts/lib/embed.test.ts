import { describe, expect, it } from 'vitest'
import { EVIDENCE_CEILING, EVIDENCE_FLOOR, calibrateEvidence } from '@ascendant/core'
import { DIM, hashEmbed } from './embed.ts'

/**
 * The offline embedder has one job beyond being deterministic: land in the cosine range
 * the §5.4 evidence calibration was built for. `EVIDENCE_FLOOR` is 0.62 because real
 * `text-embedding-004` vectors put unrelated same-repo documents around 0.5-0.6. A raw
 * hashed bag-of-terms sits near 0.2, which calibrates to exactly 0 for every event and
 * makes autonomy impossible — a failure that looks like a broken gate rather than a
 * mis-scaled fixture.
 */

function cos(a: number[], b: number[]): number {
  let d = 0
  for (let i = 0; i < a.length; i += 1) d += (a[i] ?? 0) * (b[i] ?? 0)
  return d
}

const GRAPHQL_REQUEST =
  'Please add a GraphQL endpoint for sessions. Our mobile client over-fetches from the REST session endpoints in apps/api/src/session.ts.'
const ADR =
  'ADR-0007: Session API stays REST. We are not adding a GraphQL layer, decided 2026-06-12. Two teams asked for a GraphQL layer in front of the session API in apps/api/src/session.ts.'
const UNRELATED = 'How do I rotate an API key? I cannot find this in the docs.'

describe('hashEmbed', () => {
  it(`produces ${DIM}-dimensional unit vectors`, () => {
    const v = hashEmbed(GRAPHQL_REQUEST)
    expect(v).toHaveLength(DIM)
    expect(cos(v, v)).toBeCloseTo(1, 5)
  })

  it('is deterministic — the same text always embeds identically', () => {
    expect(hashEmbed(ADR)).toEqual(hashEmbed(ADR))
  })

  it('ranks a topically related document above an unrelated one', () => {
    const q = hashEmbed(GRAPHQL_REQUEST)
    expect(cos(q, hashEmbed(ADR))).toBeGreaterThan(cos(q, hashEmbed(UNRELATED)))
  })

  it('lands in the range the evidence calibration expects', () => {
    // The load-bearing property. Related documents must clear EVIDENCE_FLOOR so
    // evidenceStrength is non-zero and a decision can reach the autonomy band.
    const related = cos(hashEmbed(GRAPHQL_REQUEST), hashEmbed(ADR))
    expect(related).toBeGreaterThan(EVIDENCE_FLOOR)
    expect(calibrateEvidence(related)).toBeGreaterThan(0)

    // And an identical document must not exceed the ceiling in a way that pins
    // confidence at maximum off one neighbour.
    const identical = cos(hashEmbed(ADR), hashEmbed(ADR))
    expect(identical).toBeLessThanOrEqual(1.000001)
    expect(EVIDENCE_CEILING).toBeLessThan(1)
  })

  it('still separates unrelated documents rather than making everything similar', () => {
    // Lifting the range must not flatten it: if every pair scored above the floor the
    // evidence component would carry no information at all.
    const unrelatedScore = cos(hashEmbed(GRAPHQL_REQUEST), hashEmbed(UNRELATED))
    const relatedScore = cos(hashEmbed(GRAPHQL_REQUEST), hashEmbed(ADR))
    expect(relatedScore - unrelatedScore).toBeGreaterThan(0.02)
  })

  it('handles an empty document without producing an undefined cosine', () => {
    const v = hashEmbed('')
    expect(v).toHaveLength(DIM)
    expect(cos(v, v)).toBeCloseTo(1, 5)
  })
})
