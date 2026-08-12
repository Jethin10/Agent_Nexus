import { sql } from 'drizzle-orm'
import type { Db } from '../client'
import { executeRows } from '../client'
import type { OutboxRow } from '../schema/outbox'

export type OutboxKind = 'inngest_event' | 'slack_notification' | 'linear_transition'

export async function enqueueOutbox(db: Db, input: {
  orgId: string
  dedupeKey: string
  kind: OutboxKind
  aggregateId: string
  payload: Record<string, unknown>
}): Promise<void> {
  await db.execute(sql`
    insert into outbox (org_id, dedupe_key, kind, aggregate_id, payload)
    values (${input.orgId}, ${input.dedupeKey}, ${input.kind}, ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
    on conflict (org_id, dedupe_key) do nothing
  `)
}

/** Atomically leases ready rows. Expired leases are safely reclaimable. */
export async function claimOutbox(db: Db, workerId: string, limit = 20): Promise<OutboxRow[]> {
  return executeRows<OutboxRow>(db, sql`
    with candidates as (
      select id from outbox
      where available_at <= now()
        and (status = 'pending' or (status = 'processing' and locked_until < now()))
      order by created_at
      for update skip locked
      limit ${Math.max(1, Math.min(limit, 100))}
    )
    update outbox o set
      status = 'processing', locked_by = ${workerId},
      locked_until = now() + interval '5 minutes', attempts = attempts + 1
    from candidates c where o.id = c.id
    returning o.*
  `)
}

export async function completeOutbox(db: Db, id: string, workerId: string): Promise<boolean> {
  const rows = await executeRows<{ id: string }>(db, sql`
    update outbox set status = 'done', completed_at = now(), locked_by = null,
      locked_until = null, last_error = null
    where id = ${id}::uuid and status = 'processing' and locked_by = ${workerId}
    returning id
  `)
  return rows.length === 1
}

export async function retryOutbox(
  db: Db,
  row: Pick<OutboxRow, 'id' | 'attempts'>,
  workerId: string,
  error: unknown,
): Promise<boolean> {
  const delaySeconds = Math.min(3600, 2 ** Math.min(row.attempts, 10) * 5)
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
  const rows = await executeRows<{ id: string }>(db, sql`
    update outbox set status = 'pending', available_at = now() + (${delaySeconds} * interval '1 second'),
      locked_by = null, locked_until = null, last_error = ${message}
    where id = ${row.id}::uuid and status = 'processing' and locked_by = ${workerId}
    returning id
  `)
  return rows.length === 1
}
