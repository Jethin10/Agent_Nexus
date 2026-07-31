import { z } from 'zod'

/**
 * Five outcomes, never binary. Four of them are refusals — that is the product.
 */
export const TriageOutcome = z.enum([
  'ACCEPT',
  'REJECT',
  'MERGE',
  'DEFER',
  'ESCALATE',
])
export type TriageOutcome = z.infer<typeof TriageOutcome>

export const Citation = z.object({
  kind: z.enum(['issue', 'pr', 'commit', 'doc', 'message', 'meeting', 'ticket']),
  ref: z.string().min(1), // URL or stable id
  quote: z.string().max(400),
  why: z.string().max(200),
})
export type Citation = z.infer<typeof Citation>

const TriageDecisionShape = z.object({
  eventId: z.string().uuid(),
  outcome: TriageOutcome,
  confidence: z.number().min(0).max(1),
  /** Human-readable; this text goes verbatim into the issue comment. */
  reasoning: z.string().min(40).max(1200),
  /**
   * A decision with no evidence is invalid by construction. The model cannot
   * claim "duplicate" without naming what it duplicates. When Zod rejects this,
   * the router retries once with the validation error appended (§10.3) —
   * which turns a hallucination class into a bounded retry.
   */
  citations: z.array(Citation).min(1),
  mergeTargetId: z.string().optional(), // required when outcome === 'MERGE'
  missingInfo: z.array(z.string()).optional(), // required when outcome === 'DEFER'
  policyHits: z.array(z.string()).default([]),
  modelUsed: z.string(),
  latencyMs: z.number().nonnegative(),
})

/**
 * PLAN.md §5.1 declares mergeTargetId/missingInfo conditionally required but
 * types them .optional(), so nothing enforced it. Enforced here, in the same
 * spirit as citations.min(1): the outcome and its evidence must agree.
 */
export const TriageDecision = TriageDecisionShape.superRefine((d, ctx) => {
  if (d.outcome === 'MERGE' && !d.mergeTargetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mergeTargetId'],
      message: 'MERGE requires mergeTargetId: name the item this duplicates.',
    })
  }
  if (d.outcome === 'DEFER' && !d.missingInfo?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['missingInfo'],
      message: 'DEFER requires missingInfo: list the specific questions to ask.',
    })
  }
})
export type TriageDecision = z.infer<typeof TriageDecision>

/** The shape the LLM is asked to produce — no server-computed fields. */
export const TriageDecisionDraft = TriageDecisionShape.omit({
  eventId: true,
  policyHits: true,
  modelUsed: true,
  latencyMs: true,
})
export type TriageDecisionDraft = z.infer<typeof TriageDecisionDraft>
