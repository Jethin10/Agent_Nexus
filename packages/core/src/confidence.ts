import { CONFIDENCE } from './limits.js'
import type { TrustLevel } from './ids.js'
import type { TriageOutcome } from './triage.js'

/**
 * §5.4. Confidence is not the model's self-report. A model asked "how sure are
 * you" is sure of everything, so its number is one of three inputs and carries
 * only half the weight:
 *
 *   confidence = 0.5 * model_self_report
 *              + 0.3 * evidence_strength   // best citation similarity, calibrated
 *              + 0.2 * policy_agreement    // do the deterministic rules concur?
 *
 * All three components are stored per-decision so calibration is auditable after
 * the fact rather than being a number nobody can reconstruct.
 */
export const WEIGHTS = {
  modelSelfReport: 0.5,
  evidenceStrength: 0.3,
  policyAgreement: 0.2,
} as const

/** Bands, overridable from the `config` table — the demo drags these live. */
export interface ConfidenceBands {
  /** >= act autonomously. */
  autonomous: number
  /** >= act but flag needsReview; below this, ESCALATE. */
  flagged: number
  /** Ceiling applied when prompt-guard flagged the body (§15.3 layer 1). */
  injectionCeiling: number
}

export const DEFAULT_BANDS: ConfidenceBands = {
  autonomous: CONFIDENCE.AUTONOMOUS,
  flagged: CONFIDENCE.FLAGGED,
  injectionCeiling: CONFIDENCE.INJECTION_CEILING,
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Cosine similarity of the best citation, mapped onto [0,1] as an evidence score.
 *
 * Raw cosine is a bad score directly: on a small corpus, unrelated issues in the
 * same repo sit around 0.5-0.6 purely because they share vocabulary, so an
 * uncalibrated 0.6 would read as decent evidence when it means nothing. The floor
 * discards that band entirely and the ceiling stops one near-identical neighbour
 * from pinning the whole decision at maximum confidence.
 */
export const EVIDENCE_FLOOR = 0.62
export const EVIDENCE_CEILING = 0.92

export function calibrateEvidence(bestSimilarity: number | undefined): number {
  if (bestSimilarity === undefined) return 0
  const span = EVIDENCE_CEILING - EVIDENCE_FLOOR
  return clamp01((bestSimilarity - EVIDENCE_FLOOR) / span)
}

export interface ConfidenceInput {
  /** The model's own 0-1 number, straight from the decision draft. */
  modelSelfReport: number
  /** Best citation cosine similarity, pre-calibration. Undefined = no neighbour. */
  bestSimilarity?: number
  /** From policyAgreement() in policy.ts. */
  policyAgreement: number
}

export interface ConfidenceComponents {
  modelSelfReport: number
  evidenceStrength: number
  policyAgreement: number
}

export function computeComponents(input: ConfidenceInput): ConfidenceComponents {
  return {
    modelSelfReport: clamp01(input.modelSelfReport),
    evidenceStrength: calibrateEvidence(input.bestSimilarity),
    policyAgreement: clamp01(input.policyAgreement),
  }
}

export function weightedConfidence(c: ConfidenceComponents): number {
  return clamp01(
    WEIGHTS.modelSelfReport * c.modelSelfReport +
      WEIGHTS.evidenceStrength * c.evidenceStrength +
      WEIGHTS.policyAgreement * c.policyAgreement,
  )
}

export interface BandInput extends ConfidenceInput {
  /** The outcome the model chose, before banding may override it. */
  outcome: TriageOutcome
  /** §15.3 layer 1: a prompt-guard hit caps confidence and forces ESCALATE. */
  injectionSuspected?: boolean
  /** §15.3 layer 3: anonymous filings get a lower autonomy ceiling. */
  trust?: TrustLevel
  /** From the `config` table. Never read the constants directly (§5.4). */
  bands?: ConfidenceBands
}

export interface BandedDecision {
  outcome: TriageOutcome
  confidence: number
  components: ConfidenceComponents
  /** True only when the gate may act with no human in the loop. */
  autonomous: boolean
  /** Acted on, but surfaced for one-click overturn. */
  needsReview: boolean
  /** Machine-readable reasons the band moved, for the decision row and the UI. */
  applied: string[]
}

/**
 * Turns three components into the outcome and the autonomy flags. This is the one
 * place the bands are interpreted, so "what is the system allowed to do" has a
 * single answer rather than being re-derived at every call site.
 *
 * Order matters. The injection ceiling is applied to the *number* before banding,
 * so a suspected-injection event cannot land in the autonomous band by arithmetic;
 * the trust ceiling then removes autonomy without touching the confidence, because
 * an anonymous filing may be judged correctly and still not be actioned alone.
 */
export function band(input: BandInput): BandedDecision {
  const bands = input.bands ?? DEFAULT_BANDS
  const components = computeComponents(input)
  const applied: string[] = []

  let confidence = weightedConfidence(components)
  let outcome = input.outcome

  if (input.injectionSuspected && confidence > bands.injectionCeiling) {
    confidence = bands.injectionCeiling
    applied.push('injection_ceiling')
  }

  if (confidence < bands.flagged && outcome !== 'ESCALATE') {
    outcome = 'ESCALATE'
    applied.push('below_flagged_band')
  }
  if (input.injectionSuspected && outcome !== 'ESCALATE') {
    outcome = 'ESCALATE'
    applied.push('injection_suspected')
  }

  let autonomous = confidence >= bands.autonomous && outcome !== 'ESCALATE'

  // Layer 3: anonymous events can be triaged and can produce a draft PR, but an
  // autonomous close is not available to them at any confidence.
  if (autonomous && input.trust === 'anonymous' && (outcome === 'REJECT' || outcome === 'MERGE')) {
    autonomous = false
    applied.push('anonymous_no_autonomous_close')
  }

  /**
   * needsReview means "acted on, but a human should see it" — the 0.55-0.79 band.
   * ESCALATE is not acted on at all, so it is not flagged for review; it is
   * already sitting in a human's queue by construction.
   */
  const needsReview = outcome !== 'ESCALATE' && !autonomous

  return { outcome, confidence, components, autonomous, needsReview, applied }
}
