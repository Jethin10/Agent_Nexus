import { LIMITS, isBlockedPath, scanDiff, untrustedBlock, type DiffScan } from '@ascendant/core'
import {
  CodeOutput,
  PlanOutput,
  QaOutput,
  ResearchOutput,
  ReviewOutput,
  RoutingOutput,
  type ReviewOutput as ReviewOutputT,
} from './schemas.js'
import {
  CODER_SYSTEM,
  ORCHESTRATOR_SYSTEM,
  PLANNER_SYSTEM,
  QA_SYSTEM,
  REVIEWER_SYSTEM,
  RESEARCH_SYSTEM,
  conventionBlock,
  fileBlock,
} from './prompts.js'
import type { AgentContext, AgentCost } from './types.js'

/**
 * Agents 1 and 3-7, each a pure function `(ctx, input) => output` per R1. None of
 * them opens a file, calls GitHub, or touches the database; the sandbox result
 * arrives as data and the diff leaves as data.
 *
 * That is what makes the debate in §4.2 replayable: given the same stored inputs,
 * the same argument runs again.
 */

export interface Sized {
  complexity: 'trivial' | 'standard' | 'complex'
  suggestedTokens: number
  reason: string
  cost: AgentCost
}

/** Agent 1 — Orchestrator, on the cheap 8b tier. Routing, not reasoning. */
export async function orchestrate(
  ctx: AgentContext,
  input: { title: string; statement: string },
): Promise<Sized> {
  const res = await ctx.complete({
    task: 'classify',
    schema: RoutingOutput,
    system: ORCHESTRATOR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: untrustedBlock({
          source: 'ticket',
          trust: 'internal',
          text: `${input.title}\n\n${input.statement}`,
        }),
      },
    ],
    maxTokens: 300,
  })
  await ctx.trace?.({
    agent: 'orchestrator',
    phase: 'sized',
    summary: `${res.value.complexity}, ~${res.value.suggestedTokens} tokens`,
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })
  return {
    ...res.value,
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
}

export interface ResearchInput {
  title: string
  statement: string
  /** Repo file listing. The workflow reads it; the agent only reasons about it. */
  fileList: readonly string[]
  /** Citations from the triage decision — the constraints already established. */
  priorRefs?: readonly { ref: string; quote: string }[]
}

/** Agent 3 — Research. Maps the territory; proposes nothing. */
export async function research(ctx: AgentContext, input: ResearchInput) {
  const prior = input.priorRefs?.length
    ? `\n\n## PRIOR DECISIONS THAT CONSTRAIN THIS\n${input.priorRefs
        .map((p) => `- ${p.ref}: ${p.quote}`)
        .join('\n')}`
    : ''

  const res = await ctx.complete({
    task: 'plan',
    schema: ResearchOutput,
    system: RESEARCH_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `## TICKET\n${untrustedBlock({
          source: 'ticket',
          trust: 'internal',
          text: `${input.title}\n\n${input.statement}`,
        })}${prior}\n\n## REPOSITORY FILES\n${input.fileList.slice(0, 800).join('\n')}`,
      },
    ],
    maxTokens: 1_200,
  })

  await ctx.trace?.({
    agent: 'research',
    phase: 'mapped',
    summary: `${res.value.files.length} files, ${res.value.priorArt.length} prior refs, ${res.value.openQuestions.length} open questions`,
    detail: { files: res.value.files.map((f) => f.path) },
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })

  return {
    ...res.value,
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
}

export interface PlanInput {
  title: string
  statement: string
  research: { summary: string; files: readonly { path: string; why: string }[] }
  /** Contents of the files the Research agent named, already read by the workflow. */
  files: readonly { path: string; content: string }[]
  conventions?: readonly string[]
  /** Round 1's critique, when the Planner is revising rather than proposing. */
  critique?: ReviewOutputT
  round?: number
}

/**
 * Agent 4 — Planner. Proposes, or refuses to.
 *
 * The §4.2 caps are re-checked here after validation, because a plan can satisfy the
 * schema and still be too large: `filesTouched` is capped by Zod, but a plan whose
 * *steps* span more paths than it declared would slip through. A cap hit is an
 * ESCALATE with the reasoning attached, never a truncated plan that looks complete.
 */
export async function plan(ctx: AgentContext, input: PlanInput) {
  const critique = input.critique
    ? `\n\n## THE REVIEWER'S OBJECTIONS TO YOUR PREVIOUS PLAN\n${input.critique.summary}\n${input.critique.comments
        .map((c) => `- [${c.severity}] ${c.path}: ${c.comment}`)
        .join('\n')}\n\nRevise the plan, or defend it concretely.`
    : ''

  const res = await ctx.complete({
    task: 'plan',
    schema: PlanOutput,
    system: PLANNER_SYSTEM + conventionBlock(input.conventions ?? []),
    messages: [
      {
        role: 'user',
        content: `## TICKET\n${untrustedBlock({
          source: 'ticket',
          trust: 'internal',
          text: `${input.title}\n\n${input.statement}`,
        })}\n\n## RESEARCH\n${input.research.summary}\n\n## FILES\n${input.files
          .map((f) => fileBlock(f.path, f.content))
          .join('\n\n')}${critique}`,
      },
    ],
    maxTokens: 2_000,
  })

  const p = res.value
  const pathsInSteps = new Set(p.steps.map((s) => s.path))
  const overFiles = Math.max(p.filesTouched.length, pathsInSteps.size) > LIMITS.MAX_FILES_TOUCHED
  const blocked = [...pathsInSteps, ...p.filesTouched].filter(isBlockedPath)

  let verdict = p.verdict
  const reasons: string[] = []
  if (p.escalateReason) reasons.push(p.escalateReason)
  if (overFiles) {
    verdict = 'escalate'
    reasons.push(
      `The plan spans ${Math.max(p.filesTouched.length, pathsInSteps.size)} files, over the ${
        LIMITS.MAX_FILES_TOUCHED
      }-file ceiling. This is a bounded-work system; a change this wide needs a human to own it.`,
    )
  }
  if (blocked.length) {
    // Layer 3: capability, not persuasion. A plan that intends to touch CI config
    // is stopped here as well as at the diff, because the earlier it stops the less
    // budget it burns.
    verdict = 'escalate'
    reasons.push(`The plan touches protected paths: ${[...new Set(blocked)].join(', ')}.`)
  }

  await ctx.trace?.({
    agent: 'planner',
    phase: input.critique ? 'revised' : 'proposed',
    round: input.round ?? 1,
    summary:
      verdict === 'escalate'
        ? `ESCALATE: ${reasons[0] ?? 'the planner declined to plan this'}`
        : `${p.steps.length} steps across ${p.filesTouched.length} files, ${p.risks.length} risks flagged`,
    detail: { verdict, filesTouched: p.filesTouched, blocked, risks: p.risks },
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })

  return {
    ...p,
    verdict,
    ...(reasons.length ? { escalateReason: reasons.join(' ') } : {}),
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
}

export interface ReviewInput {
  plan: { statement: string; steps: readonly { order: number; path: string; change: string }[] }
  diff: string
  /** The deterministic scan's findings — the Reviewer sees them, never re-derives them. */
  scan: DiffScan
  conventions?: readonly string[]
  round?: number
}

export interface CodeInput {
  title: string
  statement: string
  plan: { statement: string; steps: readonly { order: number; path: string; change: string }[] }
  files: readonly { path: string; content: string }[]
  conventions?: readonly string[]
  /** The Reviewer's objections, when revising rather than writing fresh. */
  critique?: ReviewOutputT
  /** QA's failures, when fixing a red test run. */
  failures?: readonly { test: string; message: string; rootCauseGuess?: string }[]
  round?: number
}

/**
 * Agent 5 — Coder. Produces a diff and nothing else.
 *
 * The scan is run on the way out, not merely on the way in to review: the Coder is
 * the only agent whose output can reach a repository, so this is where §15.3 layer 4
 * belongs. `scanDiff` is deterministic and returns findings rather than throwing, so
 * a blocked diff still carries its explanation to the human who has to judge it.
 */
export async function code(ctx: AgentContext, input: CodeInput) {
  const critique = input.critique
    ? `\n\n## THE REVIEWER'S OBJECTIONS\n${input.critique.summary}\n${input.critique.comments
        .map((c) => `- [${c.severity}] ${c.path}${c.line ? `:${c.line}` : ''} — ${c.comment}`)
        .join('\n')}\n\nFix each one, or explain concretely why it is wrong.`
    : ''

  const failures = input.failures?.length
    ? `\n\n## FAILING TESTS\n${input.failures
        .map(
          (f) =>
            `- ${f.test}: ${f.message}${f.rootCauseGuess ? `\n  QA's guess at cause: ${f.rootCauseGuess}` : ''}`,
        )
        .join('\n')}\n\nMake these pass without deleting or weakening them.`
    : ''

  const res = await ctx.complete({
    task: 'code',
    schema: CodeOutput,
    system: CODER_SYSTEM + conventionBlock(input.conventions ?? []),
    messages: [
      {
        role: 'user',
        content: `## TICKET\n${untrustedBlock({
          source: 'ticket',
          trust: 'internal',
          text: `${input.title}\n\n${input.statement}`,
        })}\n\n## PLAN\n${input.plan.statement}\n${input.plan.steps
          .map((s) => `${s.order}. ${s.path}: ${s.change}`)
          .join('\n')}\n\n## CURRENT FILE CONTENTS\n${input.files
          .map((f) => fileBlock(f.path, f.content))
          .join('\n\n')}${critique}${failures}`,
      },
    ],
    maxTokens: 4_000,
    temperature: 0.1,
  })

  const scan = scanDiff(res.value.diff, { maxLines: LIMITS.MAX_DIFF_LINES })

  await ctx.trace?.({
    agent: 'coder',
    phase: input.critique || input.failures ? 'revised' : 'wrote_diff',
    round: input.round ?? 1,
    summary: `${scan.parsed.files.length} files, +${scan.parsed.addedLines}/-${scan.parsed.removedLines}${
      scan.mustEscalate ? ` — BLOCKED: ${scan.findings.map((f) => f.rule).join(', ')}` : ''
    }`,
    detail: {
      filesTouched: scan.parsed.files.map((f) => f.path),
      findings: scan.findings,
      erosion: scan.erosion,
    },
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })

  return {
    ...res.value,
    scan,
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
}

/**
 * Agent 6 — Reviewer. Critiques a diff.
 *
 * The deterministic findings are handed in as input rather than being left for the
 * model to notice. Two reasons: a model is good at "is this correct" and bad at
 * "does this string contain a credential", and a finding that is already proven does
 * not need a second opinion. The Reviewer's verdict is then *floored* by the scan —
 * an approve on a diff carrying a blocker is overridden, because §14.3's rules are
 * rules rather than suggestions.
 */
export async function review(ctx: AgentContext, input: ReviewInput) {
  const findings = input.scan.findings.length
    ? `\n\n## DETERMINISTIC SCAN RESULTS (already proven — do not re-litigate)\n${input.scan.findings
        .map((f) => `- [${f.severity}] ${f.rule} in ${f.path}: ${f.why}`)
        .join('\n')}`
    : '\n\n## DETERMINISTIC SCAN RESULTS\nNo automated findings. Judge correctness yourself.'

  const res = await ctx.complete({
    task: 'review',
    schema: ReviewOutput,
    system: REVIEWER_SYSTEM + conventionBlock(input.conventions ?? []),
    messages: [
      {
        role: 'user',
        content: `## THE PLAN THIS DIFF CLAIMS TO IMPLEMENT\n${input.plan.statement}\n${input.plan.steps
          .map((s) => `${s.order}. ${s.path}: ${s.change}`)
          .join('\n')}\n\n## THE DIFF\n${untrustedBlock({
          source: 'coder:diff',
          trust: 'internal',
          text: input.diff,
          maxChars: 24_000,
        })}${findings}`,
      },
    ],
    maxTokens: 2_000,
  })

  const r = res.value
  let verdict = r.verdict
  const comments = [...r.comments]

  if (input.scan.mustEscalate) {
    verdict = 'reject'
    for (const f of input.scan.findings) {
      if (f.severity !== 'blocker') continue
      // Recorded as Reviewer comments so they appear in the PR's debate summary and
      // are minable by §11.3 like any other repeated objection.
      comments.push({ path: f.path, severity: 'blocker', comment: f.why, rule: f.rule })
    }
  }

  await ctx.trace?.({
    agent: 'reviewer',
    phase: 'critiqued',
    round: input.round ?? 1,
    summary: `${verdict}${verdict !== r.verdict ? ` (model said ${r.verdict}; overridden by the deterministic scan)` : ''} — ${comments.length} comments`,
    detail: {
      modelVerdict: r.verdict,
      finalVerdict: verdict,
      blockers: comments.filter((c) => c.severity === 'blocker').length,
      // One row per rule, so `repeatedObjections` can mine `detail->>'rule'`.
      rules: comments.map((c) => c.rule).filter(Boolean),
    },
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })

  return {
    ...r,
    verdict,
    comments,
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
}

export interface QaInput {
  diff: string
  /** Test run from BEFORE the diff. Pre-existing failures are not this diff's fault. */
  baseline: { exitCode: number; output: string }
  /** Test run from after applying the diff. */
  after: { exitCode: number; output: string }
  /** Re-runs of failures, for flake detection. §14.3: 2 of 3 passes = flaky. */
  reruns?: readonly { exitCode: number; output: string }[]
  round?: number
}

/**
 * Agent 7 — QA. Reads sandbox output; runs nothing itself (R1).
 *
 * The baseline comparison is the load-bearing part. A repo with a pre-existing
 * failure would otherwise make every diff look like a regression, and the Coder
 * would burn its retries chasing a bug it did not introduce.
 */
export async function qa(ctx: AgentContext, input: QaInput) {
  const reruns = input.reruns?.length
    ? `\n\n## RE-RUNS OF THE FAILING SUITE\n${input.reruns
        .map((r, i) => `### re-run ${i + 1} (exit ${r.exitCode})\n${r.output.slice(0, 3_000)}`)
        .join('\n\n')}`
    : ''

  const res = await ctx.complete({
    task: 'qa',
    schema: QaOutput,
    system: QA_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `## BASELINE, BEFORE THE DIFF (exit ${input.baseline.exitCode})\n${untrustedBlock({
          source: 'sandbox:baseline',
          trust: 'internal',
          text: input.baseline.output,
          maxChars: 8_000,
        })}\n\n## AFTER THE DIFF (exit ${input.after.exitCode})\n${untrustedBlock({
          source: 'sandbox:after',
          trust: 'internal',
          text: input.after.output,
          maxChars: 12_000,
        })}${reruns}`,
      },
    ],
    maxTokens: 1_600,
  })

  await ctx.trace?.({
    agent: 'qa',
    phase: 'ran_tests',
    round: input.round ?? 1,
    summary: `${res.value.verdict} — ${res.value.failures.length} failures, ${res.value.flaky.length} flaky (baseline exit ${input.baseline.exitCode}, after ${input.after.exitCode})`,
    detail: {
      verdict: res.value.verdict,
      failures: res.value.failures.map((f) => f.test),
      flaky: res.value.flaky,
    },
    model: res.model,
    tokens: res.tokens,
    latencyMs: res.latencyMs,
  })

  return {
    ...res.value,
    cost: { model: res.model, tokens: res.tokens, latencyMs: res.latencyMs },
  }
}
