import { and, eq, sql } from 'drizzle-orm'
import { tickets, type Db, type TicketRow } from '@ascendant/db'

/**
 * Ticket reads and state transitions. In the workflow layer rather than in
 * `packages/db` because these are pipeline-shaped operations — a status transition is
 * a workflow concern, and mirroring §8.2's `Triage → Todo → In Progress → In Review →
 * Done` belongs next to the functions that drive it.
 *
 * Every query filters on org_id (§15.4).
 */
export async function ticketById(db: Db, orgId: string, id: string): Promise<TicketRow> {
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, id)))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error(`ticket ${id} not found for org ${orgId}`)
  return row
}

export interface TicketPatch {
  status?: TicketRow['status']
  linearId?: string | null
  linearIdentifier?: string | null
  slackChannel?: string | null
  slackTs?: string | null
  branch?: string | null
  prNumber?: number | null
  prUrl?: string | null
  prIsDraft?: boolean
  closedAt?: Date | null
}

export async function updateTicket(
  db: Db,
  orgId: string,
  id: string,
  patch: TicketPatch,
): Promise<void> {
  await db
    .update(tickets)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, id)))
}

/**
 * Adds to the running per-ticket totals rather than overwriting them. §10.4's ceiling
 * is cumulative across the whole pipeline, and the five functions each spend against
 * it independently — a `set` would silently reset the budget between steps.
 */
export async function addTicketSpend(
  db: Db,
  orgId: string,
  id: string,
  spend: { tokens: number; calls: number },
): Promise<void> {
  await db
    .update(tickets)
    .set({
      tokensUsed: sql`${tickets.tokensUsed} + ${spend.tokens}`,
      llmCalls: sql`${tickets.llmCalls} + ${spend.calls}`,
      updatedAt: new Date(),
    })
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, id)))
}
