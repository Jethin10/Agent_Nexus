import type { NormalizedEvent } from './event.js'
import type { TriageOutcome } from './triage.js'

/**
 * §5.2 — the deterministic stage. Six rules, run before any LLM call, over a
 * NormalizedEvent and a context the workflow layer supplies. Pure: no I/O, no
 * network, no model. They are free and instant, they catch the majority of real
 * noise, and every rule that fires lands in `policyHits` on the decision row so
 * the audit trail shows what was mechanical and what was judged.
 *
 * A decisive hit means the LLM is never called at all — that is both a cost story
 * and an accuracy story.
 */
export const POLICY_RULES = [
  'bot_author',
  'spam_signature',
  'already_closed_ref',
  'exact_dupe',
  'template_unfilled',
  'empty_body',
] as const

export type PolicyRuleId = (typeof POLICY_RULES)[number]

export interface PolicyHit {
  rule: PolicyRuleId
  outcome: TriageOutcome
  /**
   * When true the gate may skip the LLM entirely. `empty_body` is deliberately
   * decisive — asking a human for a repro costs nothing and a model cannot
   * invent one.
   */
  decisive: boolean
  /** Goes into the decision's reasoning and the outbound comment. */
  note: string
  /** Populated by exact_dupe: the item this duplicates. */
  targetRef?: string
  /** Populated by the DEFER rules: the specific questions to ask. */
  missingInfo?: string[]
}

/**
 * What the rules need to know that a NormalizedEvent alone cannot tell them.
 * The workflow layer fills this from the DB — keeping it a plain input is what
 * keeps `runPolicy` pure and unit-testable with no database.
 */
export interface PolicyContext {
  /**
   * contentHash -> ref of an OPEN item already carrying that hash. A match is an
   * exact duplicate: same canonicalized title+body, so MERGE is mechanical.
   */
  openByContentHash?: Readonly<Record<string, string>>
  /** Refs (`#412`, `ENG-88`) closed within the last 14 days. */
  recentlyClosedRefs?: readonly string[]
  /** From `config`: actor handles treated as bots beyond the provider's own flag. */
  botHandles?: readonly string[]
}

/** Below this a body cannot carry a reproduction. §5.2: "body < 20 chars". */
const MIN_BODY_CHARS = 20

/**
 * Placeholders GitHub/Linear issue templates leave behind. Matching these is
 * better than a length check: a long body that is entirely unfilled template is
 * the most common low-quality filing, and it looks substantial by every other
 * measure.
 */
const TEMPLATE_PLACEHOLDERS: readonly RegExp[] = [
  /<!--[\s\S]*?-->/, // HTML comment instructions left in place
  /\[ \]\s*I have searched/i,
  /^\s*(?:###?\s*)?(?:steps to reproduce|expected behaviou?r|actual behaviou?r)\s*:?\s*$/im,
  /\b(?:describe|paste|replace|add|write|insert)\s+(?:the\s+|your\s+)?[\w\s]{0,20}here\b/i,
  /\bxxx+\b/i,
  /\b(?:TODO|TBD|FILL ME IN|N\/A)\b/,
  /\.\.\.$/m,
]

/**
 * Spam is structural, not semantic: a body that is mostly links, or repeated
 * promotional phrasing. Kept narrow on purpose — a false REJECT silently drops
 * real work, which §11.2 treats as the worst error in the matrix.
 */
const SPAM_PHRASES: readonly RegExp[] = [
  /\b(?:buy|cheap|discount|coupon|casino|porn|viagra|crypto\s+giveaway)\b/i,
  /\b(?:free\s+(?:download|followers|robux|v-?bucks)|click\s+here\s+to\s+win)\b/i,
  /\b(?:seo\s+services|guest\s+post|backlinks?\s+for\s+sale)\b/i,
  /\b(?:whatsapp|telegram)\s*[:+]?\s*\+?\d[\d\s-]{7,}/i,
]

/** Fraction of a body that is bare URLs. A link-only filing carries no report. */
function linkDensity(body: string, urls: readonly string[]): number {
  const trimmed = body.trim()
  if (!trimmed) return 0
  const urlChars = urls.reduce((n, u) => n + u.length, 0)
  return urlChars / trimmed.length
}

function hasRepro(e: NormalizedEvent): boolean {
  return (
    e.extracted.stackFrames.length > 0 ||
    e.extracted.symbols.length > 0 ||
    e.attachments.length > 0
  )
}

/**
 * Runs all six rules and returns every hit, ordered by severity: REJECT before
 * ESCALATE before MERGE before DEFER. `decide()` takes the first decisive one,
 * but all hits are recorded — a spam body that is also empty should show both,
 * because the policyHits list is evidence, not just a control-flow signal.
 */
export function runPolicy(e: NormalizedEvent, ctx: PolicyContext = {}): PolicyHit[] {
  const hits: PolicyHit[] = []
  const body = e.body.trim()

  // ── bot_author → REJECT ────────────────────────────────────────────────────
  const botHandles = (ctx.botHandles ?? []).map((h) => h.toLowerCase())
  if (e.actor.isBot || botHandles.includes(e.actor.handle.toLowerCase())) {
    hits.push({
      rule: 'bot_author',
      outcome: 'REJECT',
      decisive: true,
      note: `Filed by ${e.actor.handle}, a bot or CI account. Automated reports are not triaged as work.`,
    })
  }

  // ── spam_signature → REJECT ───────────────────────────────────────────────
  const phraseHit = SPAM_PHRASES.find((re) => re.test(`${e.title}\n${body}`))
  const density = linkDensity(body, e.extracted.urls)
  const linkOnly = e.extracted.urls.length > 0 && density > 0.5 && !hasRepro(e)
  if (phraseHit || linkOnly) {
    hits.push({
      rule: 'spam_signature',
      outcome: 'REJECT',
      decisive: true,
      note: linkOnly
        ? `Body is ${Math.round(density * 100)}% link text with no reproduction, stack trace, or referenced symbol.`
        : 'Body matches a known spam pattern.',
    })
  }

  // ── already_closed_ref → ESCALATE ─────────────────────────────────────────
  // Never a silent MERGE: a "duplicate" of a recently closed issue is more often
  // a regression, and treating a regression as a duplicate buries it (§14.2).
  const closed = new Set(ctx.recentlyClosedRefs ?? [])
  const closedRef = e.extracted.issueRefs.find((r) => closed.has(r))
  if (closedRef) {
    hits.push({
      rule: 'already_closed_ref',
      outcome: 'ESCALATE',
      decisive: true,
      note: `References ${closedRef}, closed within the last 14 days. This may be a regression rather than a duplicate, so a human decides.`,
      targetRef: closedRef,
    })
  }

  // ── exact_dupe → MERGE ────────────────────────────────────────────────────
  const dupeTarget = ctx.openByContentHash?.[e.contentHash]
  if (dupeTarget) {
    hits.push({
      rule: 'exact_dupe',
      outcome: 'MERGE',
      decisive: true,
      note: `Canonicalized title and body hash byte-for-byte to ${dupeTarget}, which is still open.`,
      targetRef: dupeTarget,
    })
  }

  // ── template_unfilled → DEFER ─────────────────────────────────────────────
  const placeholders = TEMPLATE_PLACEHOLDERS.filter((re) => re.test(body))
  if (placeholders.length >= 2 && !hasRepro(e)) {
    hits.push({
      rule: 'template_unfilled',
      outcome: 'DEFER',
      decisive: true,
      note: 'The issue template is still showing its placeholders — the report has not been filled in.',
      missingInfo: [
        'What are the exact steps to reproduce this?',
        'What did you expect to happen, and what happened instead?',
        'Which version were you running, and can you include the full error output?',
      ],
    })
  }

  // ── empty_body → DEFER ────────────────────────────────────────────────────
  if (body.length < MIN_BODY_CHARS && !hasRepro(e)) {
    hits.push({
      rule: 'empty_body',
      outcome: 'DEFER',
      decisive: true,
      note:
        body.length === 0
          ? 'The body is empty: there is nothing to triage yet.'
          : `The body is ${body.length} characters with no stack trace, attachment, or referenced symbol.`,
      missingInfo: [
        'What are the exact steps to reproduce this?',
        'What is the full error message or stack trace?',
        'Which version, environment, and platform does this happen on?',
      ],
    })
  }

  return hits
}

/** Severity order for picking which decisive hit wins when several fire. */
const SEVERITY: Record<PolicyRuleId, number> = {
  bot_author: 0,
  spam_signature: 1,
  already_closed_ref: 2,
  exact_dupe: 3,
  template_unfilled: 4,
  empty_body: 5,
}

export interface PolicyVerdict {
  hits: PolicyHit[]
  /** Rule ids for the decision row's `policyHits` column. */
  ruleIds: PolicyRuleId[]
  /** The hit the gate should act on, if any rule was decisive. */
  decided?: PolicyHit
}

/**
 * The gate's pre-LLM answer. When `decided` is set the Triage agent is never
 * called: the outcome is mechanical, its evidence is a rule name, and the token
 * cost is zero.
 */
export function decide(e: NormalizedEvent, ctx: PolicyContext = {}): PolicyVerdict {
  const hits = runPolicy(e, ctx).sort((a, b) => SEVERITY[a.rule] - SEVERITY[b.rule])
  const decided = hits.find((h) => h.decisive)
  const verdict: PolicyVerdict = { hits, ruleIds: hits.map((h) => h.rule) }
  if (decided) verdict.decided = decided
  return verdict
}

/**
 * §5.4's third confidence component. Measures whether the deterministic rules
 * concur with the outcome the model chose.
 *
 * Full agreement when a rule predicted the same outcome. When rules fired but
 * disagreed, the score is deliberately low rather than zero — the rules are
 * heuristics and the model has retrieval the rules do not. When nothing fired,
 * 0.6: mild positive evidence, since the cheap noise filters found no objection.
 */
export function policyAgreement(hits: readonly PolicyHit[], outcome: TriageOutcome): number {
  if (hits.length === 0) return 0.6
  if (hits.some((h) => h.outcome === outcome)) return 1
  return 0.2
}
