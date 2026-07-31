import { and, eq, sql } from 'drizzle-orm'
import { runs, type Db } from '@ascendant/db'

/**
 * Run ids for an event. Needed because four of the five outcomes never open a ticket,
 * so their trace rows are keyed by `run_id` rather than `ticket_id` — and Run Detail
 * has to render a REJECT just as fully as an ACCEPT.
 *
 * The event id lives in `runs.meta`, written by each function's `open-run` step.
 */
export async function runsForEvent(db: Db, orgId: string, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), sql`${runs.meta} ->> 'eventId' = ${eventId}`))
    .orderBy(runs.startedAt)
    .limit(20)
  return rows.map((r) => r.id)
}
