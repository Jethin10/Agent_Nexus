import { describe, expect, it } from 'vitest'
import {
  bestSimilarity,
  estimateTokens,
  mergeCandidates,
  type Candidate,
  type RetrievalSource,
} from './candidates.js'
import { LIMITS } from './limits.js'

function cand(over: Partial<Candidate> & { entityId: string }): Candidate {
  return {
    kind: 'issue',
    ref: `acme/api#${over.entityId}`,
    title: `Issue ${over.entityId}`,
    content: 'body text',
    source: 'vector',
    score: 0.8,
    ...over,
  }
}

const ids = (cs: readonly Candidate[]) => cs.map((c) => c.entityId)

describe('mergeCandidates — union and dedupe', () => {
  it('unions the four sources', () => {
    const m = mergeCandidates([
      [cand({ entityId: 'a', source: 'vector' })],
      [cand({ entityId: 'b', source: 'lexical' })],
      [cand({ entityId: 'c', source: 'git' })],
      [cand({ entityId: 'd', source: 'decision' })],
    ])
    expect(m.candidates).toHaveLength(4)
    expect(m.bySource).toEqual({ vector: 1, lexical: 1, git: 1, decision: 1 })
  })

  it('dedupes the same entity arriving from two sources', () => {
    const m = mergeCandidates([
      [cand({ entityId: 'a', source: 'vector', score: 0.7 })],
      [cand({ entityId: 'a', source: 'lexical', score: 0.9 })],
    ])
    expect(m.candidates).toHaveLength(1)
  })

  it('keeps the higher-priority provenance but the better score', () => {
    const m = mergeCandidates([
      [cand({ entityId: 'a', source: 'lexical', score: 0.4 })],
      [cand({ entityId: 'a', source: 'decision', score: 0.9 })],
    ])
    expect(m.candidates[0]?.source).toBe('decision')
    expect(m.candidates[0]?.score).toBe(0.9)
  })

  it('excludes the event being triaged', () => {
    const m = mergeCandidates([[cand({ entityId: 'self' }), cand({ entityId: 'other' })]], {
      exclude: ['self'],
    })
    expect(ids(m.candidates)).toEqual(['other'])
  })
})

describe('mergeCandidates — ranking', () => {
  it('puts decision memory ahead of a higher-scoring lexical hit', () => {
    // The system's memory of what it already decided outranks raw string overlap.
    const m = mergeCandidates([
      [cand({ entityId: 'lex', source: 'lexical', score: 0.99 })],
      [cand({ entityId: 'dec', source: 'decision', score: 0.7, priorOutcome: 'REJECT' })],
    ])
    expect(ids(m.candidates)).toEqual(['dec', 'lex'])
  })

  it('orders git activity ahead of vector — "already fixed on main" leads', () => {
    const m = mergeCandidates([
      [cand({ entityId: 'v', source: 'vector', score: 0.95 })],
      [cand({ entityId: 'g', source: 'git', score: 0.5 })],
    ])
    expect(ids(m.candidates)).toEqual(['g', 'v'])
  })

  it('breaks ties within a source by score', () => {
    const m = mergeCandidates([
      [
        cand({ entityId: 'lo', source: 'vector', score: 0.65 }),
        cand({ entityId: 'hi', source: 'vector', score: 0.91 }),
      ],
    ])
    expect(ids(m.candidates)).toEqual(['hi', 'lo'])
  })
})

describe('mergeCandidates — caps', () => {
  it('caps at 20 candidates by default', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      cand({ entityId: `e${i}`, score: 1 - i / 100 }),
    )
    const m = mergeCandidates([many])
    expect(m.candidates).toHaveLength(LIMITS.RETRIEVAL_CANDIDATE_CAP)
    expect(m.dropped).toBe(40 - LIMITS.RETRIEVAL_CANDIDATE_CAP)
  })

  it('respects the token budget and reports what it dropped', () => {
    const fat = Array.from({ length: 5 }, (_, i) =>
      cand({ entityId: `e${i}`, content: 'x'.repeat(4000) }),
    )
    const m = mergeCandidates([fat], { tokenBudget: 2000 })
    expect(m.tokens).toBeLessThanOrEqual(2000)
    expect(m.candidates.length).toBeLessThan(5)
    expect(m.dropped).toBeGreaterThan(0)
  })

  it('always keeps at least one candidate, even if it alone busts the budget', () => {
    // A decision with zero candidates cannot satisfy citations.min(1), so
    // starving retrieval entirely would guarantee a schema failure downstream.
    const m = mergeCandidates([[cand({ entityId: 'huge', content: 'x'.repeat(100_000) })]], {
      tokenBudget: 100,
    })
    expect(m.candidates).toHaveLength(1)
  })

  it('skips an oversized candidate but keeps a later one that fits', () => {
    const m = mergeCandidates(
      [
        [
          cand({ entityId: 'small', source: 'git', score: 0.9, content: 'tiny' }),
          cand({ entityId: 'huge', source: 'git', score: 0.8, content: 'x'.repeat(40_000) }),
          cand({ entityId: 'also-small', source: 'git', score: 0.7, content: 'tiny' }),
        ],
      ],
      { tokenBudget: 500 },
    )
    expect(ids(m.candidates)).toEqual(['small', 'also-small'])
  })

  it('handles an empty retrieval without throwing', () => {
    const m = mergeCandidates([[], [], [], []])
    expect(m.candidates).toEqual([])
    expect(m.tokens).toBe(0)
    expect(m.dropped).toBe(0)
  })
})

describe('bestSimilarity', () => {
  it('is undefined with no comparable neighbour', () => {
    expect(bestSimilarity([])).toBeUndefined()
  })

  it('ignores lexical and git scores, which are not similarities', () => {
    const cs: Candidate[] = [
      cand({ entityId: 'lex', source: 'lexical', score: 0.99 }),
      cand({ entityId: 'git', source: 'git', score: 0.98 }),
    ]
    expect(bestSimilarity(cs)).toBeUndefined()
  })

  it('takes the best cosine across vector and decision hits', () => {
    const cs: Candidate[] = [
      cand({ entityId: 'v', source: 'vector', score: 0.71 }),
      cand({ entityId: 'd', source: 'decision', score: 0.88 }),
      cand({ entityId: 'l', source: 'lexical', score: 1 }),
    ]
    expect(bestSimilarity(cs)).toBe(0.88)
  })
})

describe('estimateTokens', () => {
  it('is pessimistic rather than exact', () => {
    expect(estimateTokens('x'.repeat(350))).toBe(100)
  })

  const sources: RetrievalSource[] = ['vector', 'lexical', 'git', 'decision']
  it('covers all four retrieval sources in the bySource tally', () => {
    const m = mergeCandidates([sources.map((s, i) => cand({ entityId: `e${i}`, source: s }))])
    expect(Object.keys(m.bySource).sort()).toEqual([...sources].sort())
  })
})
