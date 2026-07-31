import {
  TriageDecisionDraft,
  band,
  bestSimilarity,
  policyAgreement,
  triageUserMessage,
  validateCitations,
  TRIAGE_SYSTEM,
  type Candidate,
  type ConfidenceBands,
  type NormalizedEvent,
  type PolicyVerdict,
  type TriageOutcome,
} from '@ascendant/core'
import type { AgentContext, AgentCost } from './types.js'

/**
 * Agent 2 — the Triage Gate. This is the thesis: it decides *whether* work should
 * be done before any of it is built.
 *
 * Pure per R1. Its inputs are the normalized event, the candidate set retrieval
 * already assembled, the policy verdict the deterministic rules already produced,
 * and the bands read from `config`. It performs no I/O of its own, which is what
 * makes the most important decision in the system replayable from stored rows.
 */
export interface TriageInput {
  event: NormalizedEvent
  candidates: readonly Candidate[]
  policy: PolicyVerdict
  /** From the `config` table, never from the CONFIDENCE constants (§5.4). */
  bands?: ConfidenceBands
}

export interface TriageResult {
  outcome: TriageOutcome
  confidence: number
  reasoning: string
  citations: { kind: string; ref: string; quote: string; why: string }[]
  mergeTargetId?: string
  missingInfo?: string[]
  policyHits: string[]
  /** Stored separately so calibration is auditable after the fact (§5.4). */
  components: { modelSelfReport: number; evidenceStrength: number; policyAgreement: number }
  autonomous: boolean
  needsReview: boolean
  /** Which band rules moved the outcome — injection ceiling, trust ceiling, etc. */
  bandApplied: string[]
  /** True when the deterministic stage decided and no LLM was called. */
  decidedByPolicy: boolean
  cost: AgentCost
}

/**
 * A decisive policy hit short-circuits the model entirely (§5.2). The outcome is
 * mechanical, its evidence is a rule name, and the token cost is zero — which is
 * both a cost story and an accuracy story you can say out loud.
 *
 * Confidence is still computed through the same banding path rather than being
 * asserted at 1.0: a rule is evidence, not proof, and routing it through band()
 * means the trust and injection ceilings apply to mechanical decisions too.
 */
function fromPolicy(input: TriageInput): TriageResult {
  const hit = input.policy.decided
  if (!hit) throw new Error('fromPolicy called without a decisive hit')

  const components = {
    modelSelfReport: 0.9,
    evidenceStrength: hit.targetRef ? 1 : 0.5,
    policyAgreement: 1,
  }

  const banded = band({
    outcome: hit.outcome,
    modelSelfReport: components.modelSelfReport,
    // exact_dupe is a hash match, which is stronger evidence than any cosine.
    bestSimilarity: hit.rule === 'exact_dupe' ? 1 : 0.8,
    policyAgreement: 1,
    injectionSuspected: input.event.injectionSuspected,
    trust: input.event.trust,
    ...(input.bands ? { bands: input.bands } : {}),
  })

  const result: TriageResult = {
    outcome: banded.outcome,
    confidence: banded.confidence,
    reasoning: `${hit.note} This was decided by the deterministic rule \`${hit.rule}\`, before any model was consulted.`,
    citations: [
      {
        kind: hit.targetRef ? 'issue' : 'doc',
        ref: hit.targetRef ?? `policy:${hit.rule}`,
        quote: hit.note,
        why: `The ${hit.rule} rule fired on this event.`,
      },
    ],
    policyHits: input.policy.ruleIds,
    components: banded.components,
    autonomous: banded.autonomous,
    needsReview: banded.needsReview,
    bandApplied: banded.applied,
    decidedByPolicy: true,
    cost: { model: 'policy', tokens: 0, latencyMs: 0 },
  }
  if (hit.targetRef) result.mergeTargetId = hit.targetRef
  if (hit.missingInfo) result.missingInfo = hit.missingInfo
  return result
}

/**
 * The Triage Gate. Deterministic stage first, model second (§5.2).
 *
 * Three properties this function is responsible for, all of which make the
 * difference between an auditable decision and a confident guess:
 *
 * 1. **Citations are verified, not trusted.** Zod enforces that citations exist;
 *    `validateCitations` enforces that they are *real*. A model that cannot find a
 *    duplicate will happily cite `acme/api#412` because that shape looks like an
 *    issue ref. A fabricated ref forces ESCALATE rather than shipping a refusal
 *    that points at nothing.
 * 2. **Confidence is recomputed server-side.** The model's self-report is one of
 *    three weighted inputs and never the final number, so a model cannot talk its
 *    way into autonomy.
 * 3. **No candidates means no refusal.** With nothing to compare against, the only
 *    honest outcomes are ACCEPT or ESCALATE — a MERGE or REJECT asserted with no
 *    evidence is exactly the failure `citations.min(1)` exists to prevent.
 */
export async function triage(ctx: AgentContext, input: TriageInput): Promise<TriageResult> {
  if (input.policy.decided) {
    const result = fromPolicy(input)
    await ctx.trace?.({
      agent: 'triage',
      phase: 'decided_by_policy',
      summary: `${result.outcome} via ${input.policy.decided.rule} — no model call`,
      detail: { rule: input.policy.decided.rule, policyHits: result.policyHits },
      tokens: 0,
    })
    return result
  }

  const advisory = input.policy.hits.filter((h) => !h.decisive)

  const res = await ctx.complete({
    task: 'triage',
    schema: TriageDecisionDraft,
    system: TRIAGE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: triageUserMessage({
          event: input.event,
          candidates: input.candidates,
          policyHits: advisory,
        }),
      },
    ],
    maxTokens: 1_400,
    temperature: 0.1,
  })

  const draft = res.value
  const check = validateCitations(draft.citations, input.candidates)

  let outcome: TriageOutcome = draft.outcome
  const forced: string[] = []

  if (!check.ok) {
    outcome = 'ESCALATE'
    forced.push('fabricated_citation')
  }
  if (input.candidates.length === 0 && (outcome === 'REJECT' || outcome === 'MERGE')) {
    outcome = 'ESCALATE'
    forced.push('refusal_without_evidence')
  }

  const banded = band({
    outcome,
    modelSelfReport: draft.confidence,
    ...(bestSimilarity(check.resolved) !== undefined
      ? { bestSimilarity: bestSimilarity(check.resolved) }
      : {}),
    policyAgreement: policyAgreement(input.policy.hits, outcome),
    injectionSuspected: input.event.injectionSuspected,
    trust: input.event.trust,
    ...(input.bands ? { bands: input.bands } : {}),
  })

  const result: TriageResult = {
    outcome: banded.outcome,
    confidence: banded.confidence,
    reasoning: draft.reasoning,
    citations: draft.citations,
    policyHits: input.policy.ruleIds,
    components: banded.components,
    autonomous: banded.autonomous,
    needsReview: banded.needsReview,
    bandApplied: [...forced, ...banded.applied],
    decidedByPolicy: false,
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
  if (draft.mergeTargetId) result.mergeTargetId = draft.mergeTargetId
  if (draft.missingInfo?.length) result.missingInfo = draft.missingInfo

  await ctx.trace?.({
    agent: 'triage',
    phase: 'decided',
    summary: `${result.outcome} at ${result.confidence.toFixed(2)}${
      result.autonomous ? ' (autonomous)' : ' (human in the loop)'
    }`,
    detail: {
      modelOutcome: draft.outcome,
      finalOutcome: result.outcome,
      components: result.components,
      bandApplied: result.bandApplied,
      citedRefs: draft.citations.map((c) => c.ref),
      fabricatedRefs: check.fabricated,
      candidatesSeen: input.candidates.length,
    },
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })

  return result
}
