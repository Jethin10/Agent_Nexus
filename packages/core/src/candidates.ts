import { LIMITS } from './limits.js'
import type { Citation } from './triage.js'

/**
 * §5.3 / §9 — the candidate set. The Triage agent never sees a bare issue; it sees
 * the issue plus neighbours assembled deterministically from four sources, so its
 * job is *comparison* rather than recall. A model asked "is this a duplicate?" with
 * nothing to compare against will guess; the same model handed eight neighbours
 * will point at one.
 */
export const RETRIEVAL_SOURCES = ['vector', 'lexical', 'git', 'decision'] as const
export type RetrievalSource = (typeof RETRIEVAL_SOURCES)[number]

export interface Candidate {
  /** Stable id of the underlying row, used to dedupe across the four sources. */
  entityId: string
  /** Maps onto Citation.kind so a cited candidate needs no translation. */
  kind: Citation['kind']
  /** URL or stable upstream ref — what the citation will point at. */
  ref: string
  title: string
  /** The text the model reads. Already chunked/truncated by the query layer. */
  content: string
  /** Which retrieval source produced it. Set to the winner after merging. */
  source: RetrievalSource
  /**
   * Cosine similarity for vector hits, normalized ts_rank for lexical, symbol
   * overlap for git, cosine for decision memory. Comparable enough to rank by,
   * and only the vector figure feeds evidence_strength.
   */
  score: number
  /** Recency matters for "already fixed on main" — surfaced to the model. */
  at?: Date
  /** For decision-memory hits: what the gate previously decided about this. */
  priorOutcome?: string
  state?: 'open' | 'closed' | 'merged'
}

/**
 * Priority when the same entity comes back from several sources. Decision memory
 * wins outright: "we already rejected this exact request, here is that decision"
 * is stronger evidence than any similarity number, and it is what makes repeated
 * filings get consistent answers (§5.3 item 4).
 */
const SOURCE_RANK: Record<RetrievalSource, number> = {
  decision: 0,
  git: 1,
  vector: 2,
  lexical: 3,
}

/** Rough token estimate. Deliberately pessimistic — overrunning the TPM ceiling
 *  costs a 429 and a cascade hop, undercounting costs nothing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export interface MergeOptions {
  /** Hard cap on candidates handed to the model. Default LIMITS. */
  cap?: number
  /** Token budget for the candidate block. Default LIMITS. */
  tokenBudget?: number
  /** Entity ids to exclude — always includes the event being triaged. */
  exclude?: readonly string[]
}

export interface MergedCandidates {
  candidates: Candidate[]
  /** Estimated tokens the candidate block will occupy. */
  tokens: number
  /** Count per source after dedupe, for the Run Detail view and cost accounting. */
  bySource: Record<RetrievalSource, number>
  /** Dropped for cap or budget — surfaced so a starved retrieval is visible. */
  dropped: number
}

/**
 * Union, dedupe, rank, cap, and fit to budget. Pure, so retrieval quality is
 * unit-testable without a database: the four query functions are thin SQL and all
 * the judgement about what the model actually sees lives here.
 *
 * Ranking is by source priority first and score second, not by score alone. A
 * lexical hit at 0.9 and a prior decision at 0.7 are not on a comparable scale, and
 * sorting them together would let raw string overlap outrank the system's own
 * memory of what it decided last time.
 */
export function mergeCandidates(
  groups: readonly Candidate[][],
  opts: MergeOptions = {},
): MergedCandidates {
  const cap = opts.cap ?? LIMITS.RETRIEVAL_CANDIDATE_CAP
  const budget = opts.tokenBudget ?? LIMITS.RETRIEVAL_TOKEN_BUDGET
  const excluded = new Set(opts.exclude ?? [])

  const best = new Map<string, Candidate>()
  for (const c of groups.flat()) {
    if (excluded.has(c.entityId)) continue
    const prev = best.get(c.entityId)
    if (!prev) {
      best.set(c.entityId, c)
      continue
    }
    // Same entity from two sources: keep the higher-priority provenance, but the
    // better score, so a vector hit that also matched lexically keeps its cosine.
    const winner = SOURCE_RANK[c.source] < SOURCE_RANK[prev.source] ? c : prev
    best.set(c.entityId, { ...winner, score: Math.max(prev.score, c.score) })
  }

  const ranked = [...best.values()].sort(
    (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.score - a.score,
  )

  const candidates: Candidate[] = []
  let tokens = 0
  for (const c of ranked) {
    if (candidates.length >= cap) break
    const cost = estimateTokens(`${c.title}\n${c.content}`)
    if (tokens + cost > budget && candidates.length > 0) continue
    candidates.push(c)
    tokens += cost
  }

  const bySource: Record<RetrievalSource, number> = { vector: 0, lexical: 0, git: 0, decision: 0 }
  for (const c of candidates) bySource[c.source] += 1

  return { candidates, tokens, bySource, dropped: best.size - candidates.length }
}

/**
 * The similarity that feeds evidence_strength (§5.4). Only vector and decision
 * hits count: ts_rank is not a similarity and symbol overlap is a count, so
 * calibrating either against a cosine floor would be meaningless arithmetic.
 */
export function bestSimilarity(candidates: readonly Candidate[]): number | undefined {
  const scores = candidates
    .filter((c) => c.source === 'vector' || c.source === 'decision')
    .map((c) => c.score)
  return scores.length ? Math.max(...scores) : undefined
}

export interface CitationCheck {
  ok: boolean
  /** Refs the model cited that were never in the candidate block. */
  fabricated: string[]
  /** Candidates the citations resolved to, in citation order. */
  resolved: Candidate[]
}

/**
 * Zod can enforce that citations *exist* (§5.1 `citations.min(1)`) but not that
 * they are *real*. A model that cannot find a duplicate will happily cite
 * `acme/api#412` because that shape looks like an issue ref. This closes the gap:
 * every cited ref must appear in the candidate block the model was given.
 *
 * A fabricated citation is handled the same way as a schema failure — one repair
 * retry with the error appended, then escalate the rung (§10.3). That is what
 * makes "cites its evidence" a property rather than a hope.
 */
export function validateCitations(
  citations: readonly { ref: string }[],
  candidates: readonly Candidate[],
): CitationCheck {
  const byRef = new Map<string, Candidate>()
  for (const c of candidates) {
    byRef.set(c.ref, c)
    byRef.set(c.entityId, c)
  }

  const fabricated: string[] = []
  const resolved: Candidate[] = []
  for (const { ref } of citations) {
    const hit = byRef.get(ref) ?? byRef.get(ref.trim())
    if (hit) resolved.push(hit)
    else fabricated.push(ref)
  }
  return { ok: fabricated.length === 0, fabricated, resolved }
}
