import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import type { Citation, TriageOutcome } from '@ascendant/core'
import type { Db } from '../client'
import { decisions, type DecisionRow } from '../schema/decisions'
import { events } from '../schema/events'
import { tickets, type TicketRow } from '../schema/tickets'

/**
 * The decision table is the thesis, and it is immutable once written: there is no
 * update function here on purpose. A human who disagrees does not edit the
 * decision — they record an `overturns` row against it (§11.3), which is what makes
 * the confusion matrix derivable and the audit trail honest.
 */

export interface PersistDecisionInput {
  orgId: string
  eventId: string
  outcome: TriageOutcome
  confidence: number
  reasoning: string
  citations: Citation[]
  mergeTargetId?: string | undefined
  missingInfo?: string[] | undefined
  policyHits: string[]
  modelSelfReport?: number | undefined
  evidenceStrength?: number | undefined
  policyAgreement?: number | undefined
  autonomous: boolean
  needsReview: boolean
  modelUsed: string
  tokens?: number
  latencyMs?: number
}

export async function insertDecision(db: Db, d: PersistDecisionInput): Promise<DecisionRow> {
  const rows = await db
    .insert(decisions)
    .values({
      orgId: d.orgId,
      eventId: d.eventId,
      outcome: d.outcome,
      confidence: d.confidence,
      reasoning: d.reasoning,
      citations: d.citations,
      mergeTargetId: d.mergeTargetId ?? null,
      missingInfo: d.missingInfo ?? [],
      policyHits: d.policyHits,
      modelSelfReport: d.modelSelfReport ?? null,
      evidenceStrength: d.evidenceStrength ?? null,
      policyAgreement: d.policyAgreement ?? null,
      autonomous: d.autonomous,
      needsReview: d.needsReview,
      modelUsed: d.modelUsed,
      tokens: d.tokens ?? 0,
      latencyMs: d.latencyMs ?? 0,
    })
    .returning()

  const row = rows[0]
  if (!row) throw new Error('insertDecision: no row returned')
  return row
}

/**
 * The gate is the only door into the work pipeline. This function is the door, and
 * it refuses to open on anything but an ACCEPT — so there is no path from event to
 * code that skips triage, enforced here rather than by convention at call sites.
 *
 * The unique index on `event_id` means a redelivered webhook cannot fork the work,
 * and `decisionId` is onDelete: 'restrict' so the ticket can never outlive the
 * justification for its own existence.
 */
export async function openTicketForAccept(
  db: Db,
  input: {
    orgId: string
    decision: DecisionRow
    title: string
    statement: string
    labels?: string[]
  },
): Promise<TicketRow> {
  if (input.decision.outcome !== 'ACCEPT') {
    throw new Error(
      `openTicketForAccept: refusing to open a ticket for a ${input.decision.outcome} decision — the gate is the only door into the pipeline`,
    )
  }

  const rows = await db
    .insert(tickets)
    .values({
      orgId: input.orgId,
      eventId: input.decision.eventId,
      decisionId: input.decision.id,
      title: input.title,
      statement: input.statement,
      labels: input.labels ?? [],
    })
    .onConflictDoNothing({ target: [tickets.eventId] })
    .returning()

  const first = rows[0]
  if (first) return first

  const existing = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, input.orgId), eq(tickets.eventId, input.decision.eventId)))
    .limit(1)
  const row = existing[0]
  if (!row) throw new Error('openTicketForAccept: conflict but no existing ticket found')
  return row
}

export async function getDecision(
  db: Db,
  orgId: string,
  id: string,
): Promise<DecisionRow | undefined> {
  const rows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.orgId, orgId), eq(decisions.id, id)))
    .limit(1)
  return rows[0]
}

export async function decisionForEvent(
  db: Db,
  orgId: string,
  eventId: string,
): Promise<DecisionRow | undefined> {
  const rows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.orgId, orgId), eq(decisions.eventId, eventId)))
    .orderBy(desc(decisions.createdAt))
    .limit(1)
  return rows[0]
}

/** The Inbox: every event with its decision, filtered and ordered before pagination. */
export async function inbox(
  db: Db,
  orgId: string,
  opts: {
    outcome?: TriageOutcome
    limit?: number
    needsReview?: boolean
    query?: string
    order?: 'newest' | 'oldest'
  } = {},
) {
  const query = opts.query?.trim()
  const pattern = query ? `%${query}%` : undefined

  return db
    .select({
      eventId: events.id,
      source: events.source,
      kind: events.kind,
      sourceRef: events.sourceRef,
      title: events.title,
      bodyPreview: sql<string>`left(${events.body}, 420)`,
      actorHandle: events.actorHandle,
      trust: events.trust,
      injectionSuspected: events.injectionSuspected,
      createdAt: events.createdAt,
      decisionId: decisions.id,
      outcome: decisions.outcome,
      confidence: decisions.confidence,
      reasoning: decisions.reasoning,
      citations: decisions.citations,
      policyHits: decisions.policyHits,
      autonomous: decisions.autonomous,
      needsReview: decisions.needsReview,
      modelUsed: decisions.modelUsed,
      ticketId: tickets.id,
      ticketStatus: tickets.status,
      prUrl: tickets.prUrl,
    })
    .from(events)
    // Human review can append a corrected decision for the same event. Joining on
    // event_id alone would duplicate the inbox row and surface the stale judgement.
    .leftJoin(
      decisions,
      sql`${decisions.id} = (
        select latest.id from decisions latest
        where latest.event_id = ${events.id}
        order by latest.created_at desc, latest.id desc
        limit 1
      )`,
    )
    .leftJoin(tickets, eq(tickets.eventId, events.id))
    .where(
      and(
        eq(events.orgId, orgId),
        opts.outcome ? eq(decisions.outcome, opts.outcome) : undefined,
        opts.needsReview ? eq(decisions.needsReview, true) : undefined,
        pattern
          ? or(
              ilike(events.title, pattern),
              ilike(events.sourceRef, pattern),
              ilike(events.actorHandle, pattern),
              ilike(decisions.reasoning, pattern),
              sql`${decisions.outcome}::text ilike ${pattern}`,
            )
          : undefined,
      ),
    )
    .orderBy(opts.order === 'oldest' ? asc(events.createdAt) : desc(events.createdAt))
    .limit(opts.limit ?? 50)
}

/** Outcome distribution — the headline "four of five are refusals" number. */
export async function outcomeCounts(db: Db, orgId: string) {
  return db
    .select({
      outcome: decisions.outcome,
      n: sql<number>`count(*)::int`,
      autonomous: sql<number>`count(*) filter (where ${decisions.autonomous})::int`,
      avgConfidence: sql<number>`avg(${decisions.confidence})`,
    })
    .from(decisions)
    .where(eq(decisions.orgId, orgId))
    .groupBy(decisions.outcome)
}
