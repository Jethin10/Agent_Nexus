import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BANDS,
  EVIDENCE_CEILING,
  EVIDENCE_FLOOR,
  WEIGHTS,
  band,
  calibrateEvidence,
  computeComponents,
  weightedConfidence,
  type ConfidenceBands,
} from './confidence.js'

describe('calibrateEvidence', () => {
  it('is 0 with no neighbour at all', () => {
    expect(calibrateEvidence(undefined)).toBe(0)
  })

  it('discards the vocabulary-overlap band below the floor', () => {
    expect(calibrateEvidence(0.55)).toBe(0)
    expect(calibrateEvidence(EVIDENCE_FLOOR)).toBe(0)
  })

  it('saturates at the ceiling so one near-identical neighbour cannot pin it', () => {
    expect(calibrateEvidence(EVIDENCE_CEILING)).toBe(1)
    expect(calibrateEvidence(0.99)).toBe(1)
  })

  it('is linear between floor and ceiling', () => {
    const mid = (EVIDENCE_FLOOR + EVIDENCE_CEILING) / 2
    expect(calibrateEvidence(mid)).toBeCloseTo(0.5, 6)
  })
})

describe('weightedConfidence', () => {
  it('uses the §5.4 weights', () => {
    expect(WEIGHTS.modelSelfReport + WEIGHTS.evidenceStrength + WEIGHTS.policyAgreement).toBe(1)
  })

  it('is 1 when every component is 1', () => {
    expect(
      weightedConfidence({ modelSelfReport: 1, evidenceStrength: 1, policyAgreement: 1 }),
    ).toBe(1)
  })

  it('caps a confident model with no evidence well below the autonomous band', () => {
    // The whole point: self-report alone cannot buy autonomy.
    const c = weightedConfidence({ modelSelfReport: 1, evidenceStrength: 0, policyAgreement: 0.6 })
    expect(c).toBeCloseTo(0.62, 6)
    expect(c).toBeLessThan(DEFAULT_BANDS.autonomous)
  })

  it('clamps components into range', () => {
    const c = computeComponents({ modelSelfReport: 1.5, policyAgreement: -2 })
    expect(c.modelSelfReport).toBe(1)
    expect(c.policyAgreement).toBe(0)
  })
})

describe('band — autonomy', () => {
  it('acts autonomously on strong evidence and rule agreement', () => {
    const d = band({
      outcome: 'REJECT',
      modelSelfReport: 0.9,
      bestSimilarity: 0.9,
      policyAgreement: 1,
      trust: 'internal',
    })
    expect(d.outcome).toBe('REJECT')
    expect(d.confidence).toBeGreaterThanOrEqual(DEFAULT_BANDS.autonomous)
    expect(d.autonomous).toBe(true)
    expect(d.needsReview).toBe(false)
    expect(d.applied).toEqual([])
  })

  it('acts but flags for review in the middle band', () => {
    const d = band({
      outcome: 'ACCEPT',
      modelSelfReport: 0.8,
      bestSimilarity: 0.75,
      policyAgreement: 0.6,
    })
    expect(d.confidence).toBeGreaterThanOrEqual(DEFAULT_BANDS.flagged)
    expect(d.confidence).toBeLessThan(DEFAULT_BANDS.autonomous)
    expect(d.outcome).toBe('ACCEPT')
    expect(d.autonomous).toBe(false)
    expect(d.needsReview).toBe(true)
  })

  it('rewrites the outcome to ESCALATE below the flagged band', () => {
    const d = band({ outcome: 'REJECT', modelSelfReport: 0.3, policyAgreement: 0.2 })
    expect(d.outcome).toBe('ESCALATE')
    expect(d.applied).toContain('below_flagged_band')
    expect(d.autonomous).toBe(false)
    // ESCALATE is already in a human's queue, so it is not also "needs review".
    expect(d.needsReview).toBe(false)
  })

  it('leaves an already-ESCALATE outcome alone', () => {
    const d = band({ outcome: 'ESCALATE', modelSelfReport: 0.2, policyAgreement: 0.2 })
    expect(d.outcome).toBe('ESCALATE')
    expect(d.applied).toEqual([])
  })
})

describe('band — §15.3 layer 1, injection', () => {
  it('caps confidence and forces ESCALATE however sure the model was', () => {
    const d = band({
      outcome: 'ACCEPT',
      modelSelfReport: 1,
      bestSimilarity: 0.95,
      policyAgreement: 1,
      injectionSuspected: true,
    })
    expect(d.confidence).toBe(DEFAULT_BANDS.injectionCeiling)
    expect(d.outcome).toBe('ESCALATE')
    expect(d.autonomous).toBe(false)
    expect(d.applied).toContain('injection_ceiling')
  })

  it('escalates a suspected injection even when confidence was already low', () => {
    const d = band({ outcome: 'ACCEPT', modelSelfReport: 0.1, policyAgreement: 0.2, injectionSuspected: true })
    expect(d.outcome).toBe('ESCALATE')
  })
})

describe('band — §15.3 layer 3, trust ceiling', () => {
  const strong = { modelSelfReport: 0.95, bestSimilarity: 0.92, policyAgreement: 1 } as const

  it('denies an anonymous filing an autonomous close, at any confidence', () => {
    const d = band({ ...strong, outcome: 'REJECT', trust: 'anonymous' })
    expect(d.confidence).toBeGreaterThanOrEqual(DEFAULT_BANDS.autonomous)
    expect(d.autonomous).toBe(false)
    expect(d.needsReview).toBe(true)
    expect(d.applied).toContain('anonymous_no_autonomous_close')
    // The judgement itself is untouched — only the privilege to act on it alone.
    expect(d.outcome).toBe('REJECT')
  })

  it('denies an anonymous autonomous MERGE too', () => {
    expect(band({ ...strong, outcome: 'MERGE', trust: 'anonymous' }).autonomous).toBe(false)
  })

  it('still allows an anonymous ACCEPT to run — it only produces a draft PR', () => {
    expect(band({ ...strong, outcome: 'ACCEPT', trust: 'anonymous' }).autonomous).toBe(true)
  })

  it('leaves known_external and internal closes alone', () => {
    expect(band({ ...strong, outcome: 'REJECT', trust: 'known_external' }).autonomous).toBe(true)
    expect(band({ ...strong, outcome: 'REJECT', trust: 'internal' }).autonomous).toBe(true)
  })
})

describe('band — thresholds come from config, not constants', () => {
  it('honours a dragged-up autonomy threshold: same decision, routed to a human (§16 beat 4)', () => {
    const input = {
      outcome: 'REJECT',
      modelSelfReport: 0.9,
      bestSimilarity: 0.88,
      policyAgreement: 1,
      trust: 'internal',
    } as const

    const before = band(input)
    expect(before.autonomous).toBe(true)

    const strict: ConfidenceBands = { ...DEFAULT_BANDS, autonomous: 0.95 }
    const after = band({ ...input, bands: strict })

    expect(after.outcome).toBe(before.outcome)
    expect(after.confidence).toBeCloseTo(before.confidence, 12)
    expect(after.autonomous).toBe(false)
    expect(after.needsReview).toBe(true)
  })

  it('honours a raised flagged floor by escalating what used to be actionable', () => {
    const strict: ConfidenceBands = { ...DEFAULT_BANDS, flagged: 0.9 }
    const d = band({ outcome: 'ACCEPT', modelSelfReport: 0.8, bestSimilarity: 0.8, policyAgreement: 0.6, bands: strict })
    expect(d.outcome).toBe('ESCALATE')
  })
})
