import { z } from 'zod'
import { LIMITS } from '@ascendant/core'

/**
 * Every agent's output schema. These are the same Zod objects the router validates
 * against, so a hallucinated shape is a bounded retry rather than a downstream crash
 * (§10.3).
 *
 * The caps here are the §4.2 hard limits expressed as *validation*, not as prompt
 * text: a Planner that proposes 30 files fails its own schema rather than being
 * politely asked not to. Caps enforced in code cannot be argued out of.
 */

export const RiskLevel = z.enum(['low', 'medium', 'high'])
export type RiskLevel = z.infer<typeof RiskLevel>

export const Severity = z.enum(['blocker', 'major', 'minor', 'nit'])
export type Severity = z.infer<typeof Severity>

/** Agent 3 — Research. Turns an accepted ticket into a map of where to look. */
export const ResearchOutput = z.object({
  summary: z.string().min(20).max(1200),
  /** Files worth reading, most relevant first. */
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        why: z.string().max(300),
      }),
    )
    .max(30),
  /** Prior decisions, PRs or docs that constrain the work. */
  priorArt: z
    .array(z.object({ ref: z.string(), relevance: z.string().max(300) }))
    .max(12)
    .default([]),
  openQuestions: z.array(z.string().max(300)).max(8).default([]),
})
export type ResearchOutput = z.infer<typeof ResearchOutput>

/** Agent 4 — Planner. An ordered change plan, or a refusal to plan. */
export const PlanOutput = z.object({
  /**
   * The Planner is allowed to refuse. §13.8: adding a dependency or changing a
   * public API contract is an ESCALATE with a written proposal, not a plan — and a
   * bounded-work system has to be able to say "this is bigger than me".
   */
  verdict: z.enum(['plan', 'escalate']),
  /** Required when verdict === 'escalate'. */
  escalateReason: z.string().max(600).optional(),
  statement: z.string().min(20).max(800),
  steps: z
    .array(
      z.object({
        order: z.number().int().min(1),
        path: z.string().min(1),
        change: z.string().min(10).max(600),
      }),
    )
    .max(40)
    .default([]),
  filesTouched: z.array(z.string().min(1)).max(LIMITS.MAX_FILES_TOUCHED).default([]),
  /** What the plan does NOT verify — copied verbatim into the PR's Risk section. */
  risks: z.array(z.object({ risk: z.string().max(400), level: RiskLevel })).max(10).default([]),
  testPlan: z.array(z.string().max(300)).max(10).default([]),
})
export type PlanOutput = z.infer<typeof PlanOutput>

/** Agent 5 — Coder. A unified diff and nothing else. */
export const CodeOutput = z.object({
  /**
   * Unified diff, applied in the sandbox. Never a set of whole files: a diff is
   * reviewable, a file dump is not, and the §14.3 test-deletion check needs to see
   * removed lines to be able to count them.
   */
  diff: z.string().min(1),
  filesTouched: z.array(z.string().min(1)).max(LIMITS.MAX_FILES_TOUCHED),
  /** How the Coder answered the Reviewer's objections, for the PR's debate summary. */
  notes: z.string().max(1200).default(''),
})
export type CodeOutput = z.infer<typeof CodeOutput>

/** Agent 6 — Reviewer. A verdict plus line comments with severities. */
export const ReviewOutput = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  summary: z.string().min(10).max(1000),
  comments: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().min(0).optional(),
        severity: Severity,
        comment: z.string().min(5).max(600),
        /** Stable id for a repeated objection, so §11.3 can mine it from the trace. */
        rule: z.string().max(80).optional(),
      }),
    )
    .max(30)
    .default([]),
})
export type ReviewOutput = z.infer<typeof ReviewOutput>

/** Agent 7 — QA. Reads a sandbox result; does not run anything itself (R1). */
export const QaOutput = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  /** Tests that failed *because of this diff*, excluding the pre-existing baseline. */
  failures: z
    .array(
      z.object({
        test: z.string().max(300),
        message: z.string().max(800),
        /** The most valuable field here: a guess at cause beats a raw log. */
        rootCauseGuess: z.string().max(600).optional(),
      }),
    )
    .max(20)
    .default([]),
  /** Passed on retry — §14.3 marks it flaky in the PR rather than failing the run. */
  flaky: z.array(z.string().max(300)).max(20).default([]),
  summary: z.string().max(1000),
})
export type QaOutput = z.infer<typeof QaOutput>

/**
 * Agent 8 — Delivery has no schema here on purpose. It makes no model call at all:
 * see `delivery.ts`, where the PR body, commit trailer and Slack summary are built
 * by template. The `Why` section must be the triage reasoning *verbatim*, and a
 * model asked to write it would paraphrase the audit trail.
 */

/** Agent 1 — Orchestrator. Cheap 8b routing, not reasoning. */
export const RoutingOutput = z.object({
  /** Is this worth the strong-model pipeline at all, or is it cheap work? */
  complexity: z.enum(['trivial', 'standard', 'complex']),
  /** Suggested per-ticket token ceiling; the config value still caps it. */
  suggestedTokens: z.number().int().min(1_000).max(LIMITS.MAX_TICKET_TOKENS),
  reason: z.string().max(400),
})
export type RoutingOutput = z.infer<typeof RoutingOutput>
