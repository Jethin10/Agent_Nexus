import { and, eq } from 'drizzle-orm'
import { db, tickets, type TicketRow } from '@ascendant/db'

/**
 * The ticket for an event, if the gate opened one. Returns null for the four refusal
 * outcomes, which is the common case: `tickets` is created only by an ACCEPT, so its
 * absence is information rather than a missing row.
 */
export async function TicketFor({
  orgId,
  eventId,
}: {
  orgId: string
  eventId: string
}): Promise<TicketRow | null> {
  const rows = await db()
    .select()
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.eventId, eventId)))
    .limit(1)
  return rows[0] ?? null
}
