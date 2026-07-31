import { and, eq, gte, ne, sql } from 'drizzle-orm'
import {
  LIMITS,
  mergeCandidates,
  type Candidate,
  type MergedCandidates,
  type NormalizedEvent,
} from '@ascendant/core'
import type { Db } from '../client'
import { decisions } from '../schema/decisions'
import { embeddings } from '../schema/embeddings'
import { events } from '../schema/events'

/**
 * §5.3 / §9 — retrieval before judgement. Four sources, unioned and capped by
 * mergeCandidates() in @ascendant/core.
 *
 * Each source is deliberately a thin, single-purpose query: all the judgement about
 * what the model actually sees lives in the pure merge function, which is why
 * retrieval quality is unit-testable without a database.
 *
 * Every query filters on org_id (§15.4).
 */

/** Top-8 by cosine. Kept small on purpose: 8 neighbours is enough to compare against. */
const K = 8

/** How much of a neighbour's text the model needs to judge similarity. */
const SNIPPET_CHARS = 700

const snippet = (s: string) => (s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)}…` : s)

/** pgvector needs a literal, not a bound array parameter, for the distance operator. */
const vecLiteral = (v: readonly number[]) => `[${v.join(',')}]`

/** Which vector column to search. Never mixed: see the embeddings schema comment. */
export type VectorDim = 768 | 384

export interface VectorQuery {
  orgId: string
  vec: readonly number[]
  dim: VectorDim
  /** Exclude the event being triaged from its own neighbour set. */
  excludeEntityId?: string
  limit?: number
}

/**
 * Retrieval source #1 — vector neighbours, top-8 by cosine over the embedded
 * corpus (open and recently closed issues, tickets, meeting notes, decision docs).
 *
 * `1 - (vec <=> query)` converts pgvector's cosine *distance* into the similarity
 * the rest of the system reasons about. Getting that backwards would rank the
 * least relevant neighbour first and silently gut retrieval, which is why the
 * conversion happens once, here.
 */
export async function vectorNeighbours(db: Db, q: VectorQuery): Promise<Candidate[]> {
  const col = q.dim === 768 ? embeddings.vec768 : embeddings.vec384
  const lit = vecLiteral(q.vec)
  const similarity = sql<number>`1 - (${col} <=> ${lit}::vector)`

  const rows = await db
    .select({
      entityId: embeddings.entityId,
      entityKind: embeddings.entityKind,
      content: embeddings.content,
      score: similarity,
    })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.orgId, q.orgId),
        sql`${col} IS NOT NULL`,
        q.excludeEntityId ? ne(embeddings.entityId, q.excludeEntityId) : undefined,
      ),
    )
    .orderBy(sql`${col} <=> ${lit}::vector`)
    .limit(q.limit ?? K)

  return rows.map((r) => ({
    entityId: r.entityId,
    kind: citationKind(r.entityKind),
    ref: r.entityId,
    title: firstLine(r.content),
    content: snippet(r.content),
    source: 'vector' as const,
    score: Number(r.score),
  }))
}

/** `entity_kind` on embeddings is polymorphic; map it onto Citation.kind. */
function citationKind(entityKind: string): Candidate['kind'] {
  switch (entityKind) {
    case 'pr':
      return 'pr'
    case 'commit':
      return 'commit'
    case 'doc':
      return 'doc'
    case 'message':
      return 'message'
    case 'meeting_note':
    case 'meeting':
      return 'meeting'
    case 'ticket':
      return 'ticket'
    default:
      return 'issue'
  }
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

export interface LexicalQuery {
  orgId: string
  /** The event's title plus its extracted symbols — exact strings, not prose. */
  terms: readonly string[]
  excludeEntityId?: string
  limit?: number
}

/**
 * Retrieval source #2 — lexical neighbours by Postgres `ts_rank`.
 *
 * This exists because embeddings blur exactly what matters most for duplicate
 * detection: an exact error string, a function name, a version number. Two issues
 * both reporting `TypeError: cannot read 'id' of undefined` are lexically
 * identical and only moderately close in vector space.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`: it tolerates arbitrary user
 * input without throwing on unbalanced operators, which a raw symbol list will
 * eventually contain.
 */
export async function lexicalNeighbours(db: Db, q: LexicalQuery): Promise<Candidate[]> {
  const query = q.terms
    .map((t) => t.replace(/[^\w\s.\-/]/g, ' ').trim())
    .filter((t) => t.length > 2)
    .slice(0, 24)
    .join(' or ')
  if (!query) return []

  const tsq = sql`websearch_to_tsquery('english', ${query})`
  const rank = sql<number>`ts_rank(to_tsvector('english', ${embeddings.content}), ${tsq})`

  const rows = await db
    .select({
      entityId: embeddings.entityId,
      entityKind: embeddings.entityKind,
      content: embeddings.content,
      rank,
    })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.orgId, q.orgId),
        sql`to_tsvector('english', ${embeddings.content}) @@ ${tsq}`,
        q.excludeEntityId ? ne(embeddings.entityId, q.excludeEntityId) : undefined,
      ),
    )
    .orderBy(sql`${rank} desc`)
    .limit(q.limit ?? K)

  return rows.map((r) => ({
    entityId: r.entityId,
    kind: citationKind(r.entityKind),
    ref: r.entityId,
    title: firstLine(r.content),
    content: snippet(r.content),
    source: 'lexical' as const,
    /**
     * ts_rank is unbounded and corpus-relative, so it is squashed into [0,1] for
     * ordering only. It deliberately never reaches evidence_strength — see
     * bestSimilarity(), which ignores lexical hits because a rank is not a
     * similarity and calibrating one against a cosine floor is meaningless.
     */
    score: Math.min(1, Number(r.rank) / 0.5),
  }))
}

export interface GitActivityQuery {
  orgId: string
  /** The event's extracted symbols — file paths and identifiers, the join keys. */
  symbols: readonly string[]
  excludeEntityId?: string
  windowDays?: number
  limit?: number
}

/**
 * Retrieval source #3 — recent git activity. Merged PRs and commits from the last
 * 21 days whose touched paths or message overlap this event's extracted symbols.
 *
 * This is the source that powers *"already fixed on `main`"*, which is the single
 * most valuable refusal the gate makes: the work is real, the report is honest, and
 * doing it would still be waste. Neither vector nor lexical retrieval finds it
 * reliably, because the fix's commit message rarely resembles the bug report.
 *
 * The overlap is computed with jsonb `?|` against the deterministically extracted
 * symbol array — exact string matching on file paths, not similarity.
 */
export async function gitActivity(db: Db, q: GitActivityQuery): Promise<Candidate[]> {
  const symbols = q.symbols.filter((s) => s.length > 2).slice(0, 40)
  if (symbols.length === 0) return []

  const since = new Date(Date.now() - (q.windowDays ?? LIMITS.GIT_ACTIVITY_WINDOW_DAYS) * 86_400_000)
  const symbolArray = sql`array[${sql.join(
    symbols.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`

  const overlap = sql<number>`(
    select count(*) from jsonb_array_elements_text(${events.extracted} -> 'symbols') as s
    where s.value = any(${symbolArray})
  )`

  const rows = await db
    .select({
      id: events.id,
      sourceRef: events.sourceRef,
      kind: events.kind,
      title: events.title,
      body: events.body,
      createdAt: events.createdAt,
      overlap,
    })
    .from(events)
    .where(
      and(
        eq(events.orgId, q.orgId),
        gte(events.createdAt, since),
        sql`${events.kind} in ('pr', 'doc')`,
        sql`${events.extracted} -> 'symbols' ?| ${symbolArray}`,
        q.excludeEntityId ? ne(events.id, q.excludeEntityId) : undefined,
      ),
    )
    .orderBy(sql`${overlap} desc`, sql`${events.createdAt} desc`)
    .limit(q.limit ?? K)

  return rows.map((r) => ({
    entityId: r.id,
    kind: r.kind === 'pr' ? ('pr' as const) : ('doc' as const),
    ref: r.sourceRef,
    title: r.title,
    content: snippet(r.body),
    source: 'git' as const,
    /** Fraction of this event's symbols the activity touched. A count, not a similarity. */
    score: Math.min(1, Number(r.overlap) / Math.min(symbols.length, 5)),
    at: r.createdAt,
    state: 'merged' as const,
  }))
}

export interface DecisionMemoryQuery {
  orgId: string
  vec: readonly number[]
  dim: VectorDim
  /** Max cosine distance. §5.3 item 4 specifies 0.15 — near-identical filings only. */
  maxDistance?: number
  excludeEventId?: string
  limit?: number
}

/**
 * Retrieval source #4 — decision memory. Prior `decisions` rows whose event sits
 * within cosine 0.15 of this one.
 *
 * This is the source that makes the gate consistent rather than merely correct. A
 * rejected feature request re-filed next month is rejected again *and cites its own
 * prior rejection*, so the filer sees a decision rather than a mood. It is also how
 * repeated ESCALATE-then-human-decides interactions compound into policy (§11.3):
 * the human's correction becomes retrievable evidence for the next similar event.
 *
 * The distance bound is deliberately tight. A loose one turns "we decided this
 * before" into "we decided something vaguely like this before", which is how an
 * automated system starts citing irrelevant precedent with total confidence.
 */
export async function decisionMemory(db: Db, q: DecisionMemoryQuery): Promise<Candidate[]> {
  const col = q.dim === 768 ? embeddings.vec768 : embeddings.vec384
  const lit = vecLiteral(q.vec)
  const distance = sql<number>`(${col} <=> ${lit}::vector)`

  const rows = await db
    .select({
      decisionId: decisions.id,
      outcome: decisions.outcome,
      confidence: decisions.confidence,
      reasoning: decisions.reasoning,
      createdAt: decisions.createdAt,
      eventTitle: events.title,
      eventRef: events.sourceRef,
      distance,
    })
    .from(decisions)
    .innerJoin(events, eq(events.id, decisions.eventId))
    .innerJoin(
      embeddings,
      and(
        /**
         * `embeddings.entity_id` is text because the table is polymorphic across
         * events, decisions, tickets and docs; `decisions.event_id` is a uuid. Postgres
         * has no implicit text = uuid cast, so the uuid is cast rather than the text
         * column — casting the other way would make the comparison unsargable and
         * discard the index on `entity_id`.
         */
        sql`${embeddings.entityId} = ${decisions.eventId}::text`,
        eq(embeddings.entityKind, 'event'),
      ),
    )
    .where(
      and(
        eq(decisions.orgId, q.orgId),
        sql`${col} IS NOT NULL`,
        sql`${distance} <= ${q.maxDistance ?? 0.15}`,
        q.excludeEventId ? ne(decisions.eventId, q.excludeEventId) : undefined,
      ),
    )
    .orderBy(sql`${distance} asc`)
    .limit(q.limit ?? K)

  return rows.map((r) => ({
    entityId: `decision:${r.decisionId}`,
    kind: 'ticket' as const,
    ref: `decision:${r.decisionId}`,
    title: `Prior decision on "${r.eventTitle}" (${r.eventRef})`,
    content: snippet(
      `We previously decided ${r.outcome} at confidence ${r.confidence.toFixed(2)}.\n${r.reasoning}`,
    ),
    source: 'decision' as const,
    score: 1 - Number(r.distance),
    at: r.createdAt,
    priorOutcome: r.outcome,
  }))
}

export interface RetrieveInput {
  orgId: string
  event: NormalizedEvent
  /** Embedding of this event. Absent when the embedding provider is exhausted. */
  vec?: readonly number[]
  dim?: VectorDim
  cap?: number
  tokenBudget?: number
}

/**
 * All four sources, unioned by the pure merge function. Sources run concurrently:
 * they are independent reads and the whole point of the gate is to decide in
 * seconds, not to be sequential for tidiness.
 *
 * A source that throws degrades to empty rather than failing the triage. Retrieval
 * is evidence-gathering, and less evidence means lower evidence_strength, which
 * means lower confidence, which routes the event to a human. That is the correct
 * failure mode — it never becomes a confident decision made blind.
 */
export async function retrieveCandidates(
  db: Db,
  input: RetrieveInput,
): Promise<MergedCandidates & { degraded: string[] }> {
  const { orgId, event } = input
  const dim = input.dim ?? 768
  const degraded: string[] = []

  const safe = async (name: string, fn: () => Promise<Candidate[]>): Promise<Candidate[]> => {
    try {
      return await fn()
    } catch {
      degraded.push(name)
      return []
    }
  }

  const terms = [event.title, ...event.extracted.symbols, ...event.extracted.stackFrames.slice(0, 4)]

  const [vector, lexical, git, decision] = await Promise.all([
    input.vec
      ? safe('vector', () =>
          vectorNeighbours(db, { orgId, vec: input.vec!, dim, excludeEntityId: event.id }),
        )
      : Promise.resolve<Candidate[]>([]),
    safe('lexical', () => lexicalNeighbours(db, { orgId, terms, excludeEntityId: event.id })),
    safe('git', () => gitActivity(db, { orgId, symbols: event.extracted.symbols, excludeEntityId: event.id })),
    input.vec
      ? safe('decision', () =>
          decisionMemory(db, { orgId, vec: input.vec!, dim, excludeEventId: event.id }),
        )
      : Promise.resolve<Candidate[]>([]),
  ])

  if (!input.vec) degraded.push('vector:no_embedding', 'decision:no_embedding')

  const merged = mergeCandidates([vector, lexical, git, decision], {
    exclude: [event.id],
    ...(input.cap !== undefined ? { cap: input.cap } : {}),
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
  })

  return { ...merged, degraded }
}
