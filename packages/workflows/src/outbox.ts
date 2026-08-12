import { randomUUID } from 'node:crypto'
import { claimOutbox, completeOutbox, db, retryOutbox, type OutboxRow } from '@ascendant/db'
import { inngest } from './events.js'

/** Drain durable external effects. Provider calls are at-least-once and must use stable ids. */
export async function drainOutbox(limit = 20): Promise<{ completed: number; retried: number }> {
  const database = db()
  const workerId = `outbox:${randomUUID()}`
  const rows = await claimOutbox(database, workerId, limit)
  let completed = 0
  let retried = 0
  for (const row of rows) {
    try {
      await dispatch(row)
      if (!(await completeOutbox(database, row.id, workerId))) {
        throw new Error('Outbox lease was lost before completion.')
      }
      completed += 1
    } catch (error) {
      await retryOutbox(database, row, workerId, error)
      retried += 1
    }
  }
  return { completed, retried }
}

async function dispatch(row: OutboxRow): Promise<void> {
  if (row.kind !== 'inngest_event') throw new Error(`Unsupported outbox kind: ${row.kind}`)
  const payload = row.payload as { id?: unknown; name?: unknown; data?: unknown }
  if (typeof payload.id !== 'string' || typeof payload.name !== 'string' || !payload.data) {
    throw new Error('Malformed Inngest outbox payload.')
  }
  await inngest.send({
    id: payload.id,
    name: payload.name as 'event/received' | 'human/resolved',
    data: payload.data as never,
  })
}

export const outboxFn = inngest.createFunction(
  { id: 'outbox-delivery', name: 'Durable outbox delivery', retries: 2 },
  [{ cron: '* * * * *' }, { event: 'maintenance/daily' }],
  async ({ step }) => step.run('drain-outbox', () => drainOutbox()),
)
