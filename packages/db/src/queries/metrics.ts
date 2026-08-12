import { and, eq, sql } from 'drizzle-orm'
import { TRIAGE_OUTCOMES } from '@ascendant/core'
import { executeRows, type Db } from '../client'
import { decisions } from '../schema/decisions'
import { outcomes, type OutcomeRow } from '../schema/outcomes'
import { overturns, type OverturnRow } from '../schema/overturns'
import { tickets } from '../schema/tickets'

/**
 * §11 — the learning loop, and the one number the project reports.
 *
 *   triage precision = 1 - (overturns / autonomous_decisions)
 *
 * Reported as a confusion matrix over the five outcomes rather than a scalar,
 * because a false REJECT (real work silently dropped) is a far worse failure than
 * a false ACCEPT (wasted tokens, and a human notices the PR). A single accuracy
 * figure hides exactly the error that matters most.
 */

const OUTCOMES = TRIAGE_OUTCOMES

export type OutcomeName = (typeof OUTCOMES)[number]
export type ConfusionMatrix = Record<OutcomeName, Record<OutcomeName, number>>

function emptyMatrix(): ConfusionMatrix {
  return Object.fromEntries(
    OUTCOMES.map((predicted) => [
      predicted,
      Object.fromEntries(OUTCOMES.map((actual) => [actual, 0])) as Record<OutcomeName, number>,
    ]),
  ) as ConfusionMatrix
}

/**
 * A human disagreed and changed the call. This is the numerator of triage
 * precision and the row that grows the eval set: the corrected pair becomes a
 * few-shot example retrieved for similar future events (§11.3).
 *
 * Recording an overturn does not mutate the decision — decisions are immutable, and
 * an audit trail you can edit is not an audit trail.
 */
export async function overturnForDecision(
  db: Db,
  orgId: string,
  decisionId: string,
): Promise<OverturnRow | undefined> {
  const rows = await db
    .select()
    .from(overturns)
    .where(and(eq(overturns.orgId, orgId), eq(overturns.decisionId, decisionId)))
    .limit(1)
  return rows[0]
}

export async function recordOverturn(
  db: Db,
  input: {
    orgId: string
    decisionId: string
    fromOutcome: OutcomeName
    toOutcome: OutcomeName
    actor: string
    reason?: string | undefined
    meta?: Record<string, unknown> | undefined
  },
): Promise<OverturnRow> {
  const rows = await db
    .insert(overturns)
    .values({
      orgId: input.orgId,
      decisionId: input.decisionId,
      fromOutcome: input.fromOutcome,
      toOutcome: input.toOutcome,
      actor: input.actor,
      reason: input.reason ?? null,
      meta: input.meta ?? null,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('recordOverturn: no row returned')
  return row
}

export interface TriagePrecision {
  autonomousDecisions: number
  overturned: number
  /** 1 - (overturns / autonomous_decisions). 1 when nothing has been decided yet. */
  precision: number
  /** matrix[predicted][actual] — only autonomous decisions are counted. */
  matrix: ConfusionMatrix
  /**
   * The cell that matters: a REJECT or MERGE the human turned into ACCEPT. Work the
   * gate silently dropped. Surfaced separately so nobody has to read the matrix to
   * find the expensive error.
   */
  falseRefusals: number
}

/**
 * The one number, computed from rows rather than asserted on a slide.
 *
 * The denominator counts only autonomous decisions on purpose. An ESCALATE that a
 * human then resolved is the system working as designed — counting it as an error
 * would punish the gate for correctly declining to guess, which is the exact
 * behaviour §11.2 is trying to reward.
 */
export async function triagePrecision(db: Db, orgId: string): Promise<TriagePrecision> {
  const [totals, pairs] = await Promise.all([
    db
      .select({
        autonomous: sql<number>`count(*) filter (where ${decisions.autonomous})::int`,
      })
      .from(decisions)
      .where(eq(decisions.orgId, orgId)),
    db
      .select({
        fromOutcome: overturns.fromOutcome,
        toOutcome: overturns.toOutcome,
        n: sql<number>`count(*)::int`,
      })
      .from(overturns)
      .innerJoin(decisions, eq(decisions.id, overturns.decisionId))
      .where(and(eq(overturns.orgId, orgId), eq(decisions.autonomous, true)))
      .groupBy(overturns.fromOutcome, overturns.toOutcome),
  ])

  const autonomousDecisions = totals[0]?.autonomous ?? 0
  const matrix = emptyMatrix()
  let overturned = 0
  let falseRefusals = 0

  for (const p of pairs) {
    const row = matrix[p.fromOutcome]
    if (row) row[p.toOutcome] = (row[p.toOutcome] ?? 0) + p.n
    overturned += p.n
    const refusal = p.fromOutcome === 'REJECT' || p.fromOutcome === 'MERGE'
    if (refusal && p.toOutcome === 'ACCEPT') falseRefusals += p.n
  }

  // Decisions nobody disagreed with are correct-by-default on the diagonal.
  const standing = await db
    .select({ outcome: decisions.outcome, n: sql<number>`count(*)::int` })
    .from(decisions)
    .where(and(eq(decisions.orgId, orgId), eq(decisions.autonomous, true)))
    .groupBy(decisions.outcome)

  for (const s of standing) {
    const row = matrix[s.outcome]
    if (!row) continue
    const disagreed = OUTCOMES.reduce((n, o) => n + (o === s.outcome ? 0 : (row[o] ?? 0)), 0)
    row[s.outcome] = Math.max(0, s.n - disagreed)
  }

  return {
    autonomousDecisions,
    overturned,
    precision: autonomousDecisions === 0 ? 1 : 1 - overturned / autonomousDecisions,
    matrix,
    falseRefusals,
  }
}

/**
 * What actually happened downstream of a decision. Without this table, "the system
 * improves over time" is a claim with no evidence behind it.
 */
export async function recordOutcome(
  db: Db,
  input: {
    orgId: string
    decisionId: string
    ticketId?: string | undefined
    kind: string
    correct?: boolean | undefined
    reviewCycles?: number
    tokensTotal?: number
    durationMs?: number | undefined
    note?: string | undefined
    meta?: Record<string, unknown> | undefined
  },
): Promise<OutcomeRow> {
  const rows = await db
    .insert(outcomes)
    .values({
      orgId: input.orgId,
      decisionId: input.decisionId,
      ticketId: input.ticketId ?? null,
      kind: input.kind,
      correct: input.correct ?? null,
      reviewCycles: input.reviewCycles ?? 0,
      tokensTotal: input.tokensTotal ?? 0,
      durationMs: input.durationMs ?? null,
      note: input.note ?? null,
      meta: input.meta ?? null,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('recordOutcome: no row returned')
  return row
}

/** The four dashboard metrics from §11.1, plus cost. One query each, all from Postgres. */
export async function dashboardMetrics(db: Db, orgId: string) {
  const [velocity, cycle, delivery, spend] = await Promise.all([
    db
      .select({
        day: sql<string>`date_trunc('day', ${decisions.createdAt})::date::text`,
        decisions: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${decisions.outcome} = 'ACCEPT')::int`,
        refused: sql<number>`count(*) filter (where ${decisions.outcome} <> 'ACCEPT')::int`,
      })
      .from(decisions)
      .where(and(eq(decisions.orgId, orgId), sql`${decisions.createdAt} >= current_date - 30`))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({
        p50: sql<number>`percentile_cont(0.5) within group (order by ${outcomes.durationMs})`,
        p90: sql<number>`percentile_cont(0.9) within group (order by ${outcomes.durationMs})`,
      })
      .from(outcomes)
      .where(and(eq(outcomes.orgId, orgId), sql`${outcomes.durationMs} is not null`)),
    db
      .select({
        status: tickets.status,
        n: sql<number>`count(*)::int`,
        merged: sql<number>`count(*) filter (where ${tickets.closedAt} is not null)::int`,
      })
      .from(tickets)
      .where(eq(tickets.orgId, orgId))
      .groupBy(tickets.status),
    db
      .select({
        tokens: sql<number>`coalesce(sum(${tickets.tokensUsed}), 0)::int`,
        calls: sql<number>`coalesce(sum(${tickets.llmCalls}), 0)::int`,
      })
      .from(tickets)
      .where(eq(tickets.orgId, orgId)),
  ])

  return {
    velocity,
    cycleTime: cycle[0] ?? { p50: 0, p90: 0 },
    delivery,
    spend: spend[0] ?? { tokens: 0, calls: 0 },
  }
}

/**
 * §11.3 signal three: a Reviewer objection repeated 3+ times is promoted into the
 * repo's convention block in the Coder's system prompt. Mined from the trace rather
 * than from a hand-maintained list, so the conventions the system enforces are the
 * ones it actually keeps having to argue about.
 */
export async function repeatedObjections(db: Db, orgId: string, minCount = 3) {
  // Row type named at the call, widened once in executeRows: `Db` is driver-agnostic
  // (see client.ts), so a raw execute has no row type until it is given one.
  return executeRows<{ rule: string; n: number }>(
    db,
    sql`
    select detail->>'rule' as rule, count(*)::int as n
    from agent_events
    where org_id = ${orgId}
      and agent = 'reviewer'
      and detail->>'rule' is not null
      and at >= current_date - 30
    group by 1
    having count(*) >= ${minCount}
    order by n desc
    limit 20
  `,
  )
}
