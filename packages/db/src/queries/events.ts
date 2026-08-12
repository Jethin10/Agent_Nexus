import { and, desc, eq, sql } from 'drizzle-orm'
import { unitKey, type NormalizedEvent } from '@ascendant/core'
import type { Db } from '../client'
import { events, type EventRow } from '../schema/events'

/**
 * Writes and reads over `events`. Nothing here ever deletes a row: the pipeline's
 * replayability depends on the input rows still being present, and `raw` is what
 * lets a `parse()` fix be replayed without re-ingesting from the provider.
 */

/** Raw payloads are truncated to keep Neon Free's 0.5 GB ceiling out of play (§9.1). */
const MAX_RAW_BYTES = 64 * 1024

function boundedRaw(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null
  const json = JSON.stringify(raw)
  if (json === undefined) return null
  if (json.length <= MAX_RAW_BYTES) return raw
  return { _truncated: true, _bytes: json.length, _head: json.slice(0, MAX_RAW_BYTES) }
}

export interface InsertedEvent {
  row: EventRow
  /**
   * False when the unique index absorbed a redelivery. Ingress may repair a failed
   * durable-dispatch attempt using the same event id; downstream decision insertion
   * remains idempotent and must never mutate an existing decision.
   */
  inserted: boolean
}

/**
 * Idempotent insert on (orgId, source, sourceRef). A redelivered webhook finds the
 * existing row and returns it with `inserted: false` — one index, and an entire
 * class of demo-day embarrassment removed (§7.3).
 */
export async function insertEvent(db: Db, e: NormalizedEvent): Promise<InsertedEvent> {
  const values = {
    id: e.id,
    orgId: e.orgId,
    source: e.source,
    sourceRef: e.sourceRef,
    kind: e.kind,
    unitKey: unitKey(e),
    threadKey: e.threadKey,
    actorId: e.actor.id,
    actorHandle: e.actor.handle,
    actorIsBot: e.actor.isBot,
    title: e.title,
    body: e.body,
    contentHash: e.contentHash,
    extracted: e.extracted,
    trust: e.trust,
    injectionSuspected: e.injectionSuspected,
    attachments: e.attachments,
    raw: boundedRaw(e.raw),
    createdAt: e.createdAt,
  }

  const inserted = await db.insert(events).values(values).onConflictDoNothing({
    target: [events.orgId, events.source, events.sourceRef],
  }).returning()

  const first = inserted[0]
  if (first) return { row: first, inserted: true }

  const existing = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.orgId, e.orgId),
        eq(events.source, e.source),
        eq(events.sourceRef, e.sourceRef),
      ),
    )
    .limit(1)

  const row = existing[0]
  if (!row) throw new Error(`insertEvent: conflict on ${e.sourceRef} but no existing row found`)
  return { row, inserted: false }
}

export async function getEvent(db: Db, orgId: string, id: string): Promise<EventRow | undefined> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.id, id)))
    .limit(1)
  return rows[0]
}

/**
 * Every event sharing a unitKey, oldest first. §7.3: a 30-comment issue is ONE unit
 * of work, so the Triage agent reads the reconstructed thread rather than being run
 * 30 times.
 */
export async function threadEvents(db: Db, orgId: string, key: string): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.unitKey, key)))
    .orderBy(events.createdAt)
    .limit(200)
}

/** Body text of a whole thread, oldest first, for the triage prompt. */
export async function threadBody(db: Db, orgId: string, key: string): Promise<string> {
  const rows = await threadEvents(db, orgId, key)
  return rows
    .map((r) => `[${r.createdAt.toISOString()}] @${r.actorHandle}:\n${r.body}`)
    .join('\n\n')
}

/** Inbox feed: newest events with their decision, if the gate has ruled yet. */
export async function recentEvents(db: Db, orgId: string, limit = 50): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(eq(events.orgId, orgId))
    .orderBy(desc(events.createdAt))
    .limit(limit)
}

/** Count by source, for the Metrics view. */
export async function eventCounts(db: Db, orgId: string) {
  return db
    .select({ source: events.source, n: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.orgId, orgId))
    .groupBy(events.source)
}
