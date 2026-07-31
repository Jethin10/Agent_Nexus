import type { Citation, DiffScan } from '@ascendant/core'
import type { ReviewOutput } from './schemas.js'

/**
 * Agent 8 — Delivery. Eight boxes in the diagram, seven of them reasoning: this one
 * is **templating plus API calls**, and deliberately so.
 *
 * It is a pure function with no model call at all. That is a stronger guarantee than
 * a cheap-tier prompt would give: the PR body is the audit trail, `Why` must be the
 * triage decision *verbatim*, and a model asked to write it would paraphrase. A
 * template cannot embellish, cannot claim work that is not in the diff, and costs
 * zero tokens against a 1,000 RPD ceiling.
 */

export interface DeliveryInput {
  ticket: { title: string; statement: string; linearIdentifier?: string | undefined }
  decision: {
    id: string
    outcome: string
    confidence: number
    reasoning: string
    citations: readonly Citation[]
  }
  plan: {
    statement: string
    steps: readonly { order: number; path: string; change: string }[]
    risks: readonly { risk: string; level: string }[]
    testPlan: readonly string[]
  }
  /** The full debate, oldest first, for the collapsed summary section. */
  debate: readonly { agent: string; round?: number | undefined; summary: string }[]
  reviews: readonly ReviewOutput[]
  qa?:
    | {
        verdict: string
        summary: string
        failures: readonly { test: string; message: string }[]
        flaky: readonly string[]
      }
    | undefined
  scan: DiffScan
  /** Commands actually run in the sandbox, for the Tests section. */
  testCommands?: readonly string[]
}

export interface DeliveryOutput {
  branch: string
  prTitle: string
  prBody: string
  commitMessage: string
  slackSummary: string
  /** Draft when confidence < 0.80. Never auto-merged, at any confidence (§8.1). */
  isDraft: boolean
}

/** §8.1: `ascendant/<linear-id>-<slug>`, never main. */
export function branchName(ticketTitle: string, linearIdentifier?: string): string {
  const slug = ticketTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  const id = (linearIdentifier ?? 'ung').toLowerCase().replace(/[^a-z0-9-]/g, '')
  return `ascendant/${id}-${slug || 'change'}`
}

/**
 * §8.1's commit trailer. `Ascendant-Decision` is the audit link: from any commit in
 * history you can retrieve the exact event, retrieval set, debate transcript and
 * review verdict that produced it. Nobody else's coding agent gives you that, and it
 * costs one git trailer.
 */
export function commitMessage(input: DeliveryInput): string {
  const subject = `${input.ticket.title}${
    input.ticket.linearIdentifier ? ` (${input.ticket.linearIdentifier})` : ''
  }`.slice(0, 72)

  return [
    subject,
    '',
    'Co-Authored-By: Ascendant <ascendant@users.noreply.github.com>',
    `Ascendant-Decision: ${input.decision.id}`,
    `Ascendant-Confidence: ${input.decision.confidence.toFixed(2)}`,
  ].join('\n')
}

function citationLink(c: Citation): string {
  const label = c.ref.startsWith('http') ? new URL(c.ref).pathname.slice(1) || c.ref : c.ref
  const ref = c.ref.startsWith('http') ? `[${label}](${c.ref})` : `\`${label}\``
  return `- ${ref} — ${c.why}\n  > ${c.quote.replace(/\n/g, ' ').slice(0, 200)}`
}

/**
 * The PR body, from a fixed template rather than free-form prose. Six sections,
 * every one of them derived from an input the pipeline already recorded.
 *
 * The `Undo` section is not decoration: every autonomous action ships with a
 * one-command reversal, which is the difference between a system an engineering org
 * would install and a party trick.
 */
export function prBody(input: DeliveryInput): string {
  const files = input.scan.parsed.files
  const stepFor = (path: string) =>
    input.plan.steps.find((s) => s.path === path)?.change ?? 'supporting change'

  const sections: string[] = []

  sections.push(
    `## What changed\n\n${input.plan.statement}\n\n${files
      .map((f) => `- \`${f.path}\` — ${stepFor(f.path)}`)
      .join('\n')}`,
  )

  // Verbatim, per DELIVERY_SYSTEM's rule. This text is the audit trail.
  sections.push(
    `## Why\n\nAscendant triaged this as **${input.decision.outcome}** at confidence ${input.decision.confidence.toFixed(
      2,
    )}.\n\n${input.decision.reasoning}\n\n**Evidence**\n\n${input.decision.citations
      .map(citationLink)
      .join('\n')}`,
  )

  const objections = input.reviews.flatMap((r) => r.comments)
  if (objections.length > 0 || input.debate.length > 0) {
    sections.push(
      `<details>\n<summary>Debate summary — ${objections.length} objections across ${input.reviews.length} review rounds</summary>\n\n${input.debate
        .map((d) => `- **${d.agent}**${d.round ? ` (round ${d.round})` : ''}: ${d.summary}`)
        .join('\n')}\n\n${objections
        .map((c) => `- [${c.severity}] \`${c.path}\`${c.line ? `:${c.line}` : ''} — ${c.comment}`)
        .join('\n')}\n\n</details>`,
    )
  }

  const tests = input.qa
    ? [
        `**${input.qa.verdict}** — ${input.qa.summary}`,
        input.testCommands?.length
          ? `\nCommands run:\n${input.testCommands.map((c) => `- \`${c}\``).join('\n')}`
          : '',
        input.qa.failures.length
          ? `\nRemaining failures:\n${input.qa.failures.map((f) => `- \`${f.test}\`: ${f.message.slice(0, 200)}`).join('\n')}`
          : '',
        input.qa.flaky.length
          ? `\nMarked flaky (passed on re-run, not treated as failures):\n${input.qa.flaky.map((t) => `- \`${t}\``).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '_No test signal was available for this change, so confidence is capped accordingly._'
  sections.push(`## Tests\n\n${tests}`)

  const risks = input.plan.risks.length
    ? input.plan.risks.map((r) => `- **${r.level}** — ${r.risk}`).join('\n')
    : '- None flagged by the Planner.'
  const notVerified = [
    input.qa ? '' : '- The test suite did not produce a usable signal.',
    input.plan.testPlan.length
      ? ''
      : '- The Planner did not specify a test plan, so coverage of the new behaviour is unverified.',
  ]
    .filter(Boolean)
    .join('\n')
  sections.push(`## Risk\n\n${risks}${notVerified ? `\n\n**Not verified**\n\n${notVerified}` : ''}`)

  sections.push(
    `## Undo\n\nComment \`/ascendant revert\` to close this PR and delete its branch. Comment \`/ascendant reopen\` on the original issue to route it to a human.\n\n---\n\n<sub>Opened by Ascendant. Decision \`${input.decision.id}\` — the full event, retrieval set and debate transcript are linked from the commit trailer. Never auto-merged: a human approves every merge.</sub>`,
  )

  return sections.join('\n\n')
}

/**
 * Assembles the whole delivery artifact. No model call, so this cannot embellish and
 * cannot fail on a rate limit.
 */
export function deliver(input: DeliveryInput, opts: { autonomousThreshold?: number } = {}): DeliveryOutput {
  const threshold = opts.autonomousThreshold ?? 0.8
  const isDraft = input.decision.confidence < threshold || input.scan.mustEscalate

  const branch = branchName(input.ticket.title, input.ticket.linearIdentifier)
  const prTitle = `${input.ticket.title}${
    input.ticket.linearIdentifier ? ` (${input.ticket.linearIdentifier})` : ''
  }`.slice(0, 120)

  const slackSummary = [
    `*${prTitle}*`,
    `${input.decision.outcome} at ${input.decision.confidence.toFixed(2)} · ${input.scan.parsed.files.length} files, +${input.scan.parsed.addedLines}/-${input.scan.parsed.removedLines}`,
    input.qa ? `Tests: ${input.qa.verdict}` : 'Tests: no signal',
    isDraft ? 'Opened as a *draft* — a human should review before it is ready.' : 'Ready for review.',
  ].join('\n')

  return {
    branch,
    prTitle,
    prBody: prBody(input),
    commitMessage: commitMessage(input),
    slackSummary,
    isDraft,
  }
}

/**
 * §5.5 — the reject/defer/merge comment. A rejection must not read like a bot
 * dismissing someone, so this is a template with a human tone and an explicit undo,
 * not a model's improvisation.
 */
export function decisionComment(input: {
  outcome: string
  confidence: number
  reasoning: string
  citations: readonly Citation[]
  mergeTargetId?: string | undefined
  missingInfo?: readonly string[] | undefined
}): string {
  const headline: Record<string, string> = {
    REJECT: 'Ascendant triaged this and is not opening work for it',
    MERGE: `Ascendant triaged this as a duplicate${input.mergeTargetId ? ` of ${input.mergeTargetId}` : ''}`,
    DEFER: 'Ascendant needs a bit more before it can triage this',
    ESCALATE: 'Ascendant has routed this to a human',
    ACCEPT: 'Ascendant accepted this as work',
  }

  const parts = [
    `**${headline[input.outcome] ?? 'Ascendant triaged this'}** (confidence ${input.confidence.toFixed(2)}).`,
    input.reasoning,
  ]

  if (input.missingInfo?.length) {
    parts.push(`Could you answer these?\n\n${input.missingInfo.map((q) => `- ${q}`).join('\n')}`)
  }

  if (input.citations.length) {
    parts.push(`**Evidence**\n\n${input.citations.map(citationLink).join('\n')}`)
  }

  parts.push(
    input.outcome === 'ESCALATE'
      ? '_A human has been notified and will decide. Nothing has been closed._'
      : "_If this is wrong, reply `/ascendant reopen` and I'll route it to a human immediately._",
  )

  return parts.join('\n\n')
}
