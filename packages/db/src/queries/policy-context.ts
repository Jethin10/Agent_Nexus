import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import type { NormalizedEvent, PolicyContext } from '@ascendant/core'
import type { Db } from '../client'
import { decisions } from '../schema/decisions'
import { events } from '../schema/events'
import { tickets } from '../schema/tickets'

/**
 * Fills the §5.2 policy rules' context from the database. The rules themselves stay
 * pure — this is the one place that knows they need SQL, which is what keeps
 * `runPolicy` unit-testable with no connection.
 *
 * Every query filters on org_id (§15.4).
 */

/** §5.2: `already_closed_ref` fires on anything closed in the last 14 days. */
const CLOSED_WINDOW_DAYS = 14

/**
 * contentHash -> ref of an OPEN item carrying that hash. Only the hash of the
 * event under triage is looked up, not the whole corpus: this is an index probe,
 * not a scan, and it runs before any LLM call on every single event.
 *
 * "Open" means an event that has either not been decided yet or was ACCEPTed into
 * a ticket that has not closed. A REJECTed duplicate is not a merge target — the
 * gate should refuse it again on its own reasoning, not link it to a refusal.
 */
export async function openByContentHash(
  db: Db,
  orgId: string,
  contentHash: string,
  excludeEventId?: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ sourceRef: events.sourceRef, outcome: decisions.outcome, closedAt: tickets.closedAt })
    .from(events)
    .leftJoin(decisions, eq(decisions.eventId, events.id))
    .leftJoin(tickets, eq(tickets.eventId, events.id))
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.contentHash, contentHash),
        excludeEventId ? ne(events.id, excludeEventId) : undefined,
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(20)

  const open = rows.find(
    (r) => (r.outcome === null || r.outcome === 'ACCEPT' || r.outcome === 'DEFER') && !r.closedAt,
  )
  return open ? { [contentHash]: open.sourceRef } : {}
}

/**
 * Refs closed within the window, intersected with the refs this event actually
 * mentions. Intersecting first keeps the query bounded: an org with 4,000 closed
 * issues does not need to hand all of them to a pure function that will check
 * membership on at most a handful.
 */
export async function recentlyClosedRefs(
  db: Db,
  orgId: string,
  mentioned: readonly string[],
): Promise<string[]> {
  const refs = mentioned.filter(Boolean).slice(0, 40)
  if (refs.length === 0) return []

  const since = new Date(Date.now() - CLOSED_WINDOW_DAYS * 86_400_000)

  /**
   * A ref is "closed" if the gate refused it, or if its ticket closed. Both are
   * checked because the two happen on different paths: a REJECT/MERGE never
   * creates a ticket, and an ACCEPT that shipped closes one.
   */
  const rows = await db
    .select({ sourceRef: events.sourceRef, suffix: sql<string>`right(${events.sourceRef}, 12)` })
    .from(events)
    .leftJoin(decisions, eq(decisions.eventId, events.id))
    .leftJoin(tickets, eq(tickets.eventId, events.id))
    .where(
      and(
        eq(events.orgId, orgId),
        gte(events.createdAt, since),
        sql`(
          ${decisions.outcome} in ('REJECT', 'MERGE')
          or ${tickets.closedAt} is not null
        )`,
      ),
    )
    .limit(500)

  /**
   * Extracted refs are short forms (`#412`, `ENG-88`) while sourceRef is fully
   * qualified (`acme/api#412`), so matching is by suffix. Anchored on the `#` or
   * the key boundary so `#12` cannot match `#912`.
   */
  const closed = new Set<string>()
  for (const ref of refs) {
    const hit = rows.some((r) => r.sourceRef === ref || r.sourceRef.endsWith(ref))
    if (hit) closed.add(ref)
  }
  return [...closed]
}

/**
 * The full PolicyContext for one event. Two queries, both index probes, both
 * cheap enough to run before every LLM call — which is the point of the
 * deterministic stage.
 */
export async function loadPolicyContext(
  db: Db,
  event: NormalizedEvent,
  botHandles: readonly string[] = [],
): Promise<PolicyContext> {
  const [byHash, closed] = await Promise.all([
    openByContentHash(db, event.orgId, event.contentHash, event.id),
    recentlyClosedRefs(db, event.orgId, event.extracted.issueRefs),
  ])
  return { openByContentHash: byHash, recentlyClosedRefs: closed, botHandles }
}

/** Merge target lookup for a MERGE decision: resolve a ref back to its event id. */
export async function resolveRefs(
  db: Db,
  orgId: string,
  refs: readonly string[],
): Promise<Map<string, string>> {
  const list = refs.filter(Boolean).slice(0, 40)
  if (list.length === 0) return new Map()
  const rows = await db
    .select({ id: events.id, sourceRef: events.sourceRef })
    .from(events)
    .where(and(eq(events.orgId, orgId), inArray(events.sourceRef, [...list])))
  return new Map(rows.map((r) => [r.sourceRef, r.id]))
}
