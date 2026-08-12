import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '../local'
import { claimOutbox, completeOutbox, enqueueOutbox, retryOutbox } from './outbox'

let handle: LocalDbHandle
beforeEach(async () => {
  handle = await makeLocalDb()
  await applyMigrations(handle.db)
})
afterEach(async () => handle.close())

describe('durable outbox', () => {
  it('deduplicates effects and leases each row to one worker', async () => {
    const input = { orgId: 'o1', dedupeKey: 'event:1', kind: 'inngest_event' as const, aggregateId: '1', payload: { id: '1' } }
    await Promise.all([enqueueOutbox(handle.db, input), enqueueOutbox(handle.db, input)])
    const [first, second] = await Promise.all([
      claimOutbox(handle.db, 'worker-a', 10),
      claimOutbox(handle.db, 'worker-b', 10),
    ])
    expect([...first, ...second]).toHaveLength(1)
    const claimed = [...first, ...second][0]!
    const owner = first.length ? 'worker-a' : 'worker-b'
    expect(await completeOutbox(handle.db, claimed.id, 'other')).toBe(false)
    expect(await completeOutbox(handle.db, claimed.id, owner)).toBe(true)
    expect(await claimOutbox(handle.db, 'worker-c', 10)).toEqual([])
  })

  it('retries failures and reclaims expired leases', async () => {
    await enqueueOutbox(handle.db, { orgId: 'o1', dedupeKey: 'event:2', kind: 'inngest_event', aggregateId: '2', payload: {} })
    const row = (await claimOutbox(handle.db, 'worker-a', 1))[0]!
    expect(await retryOutbox(handle.db, row, 'worker-a', new Error('provider down'))).toBe(true)
    await handle.db.execute(sql`update outbox set available_at = now() - interval '1 second' where id = ${row.id}::uuid`)
    expect((await claimOutbox(handle.db, 'worker-b', 1))[0]?.id).toBe(row.id)
  })

  it('atomically enqueues newly inserted events through the database trigger', async () => {
    await handle.db.execute(sql`
      insert into events (org_id, source, source_ref, kind, unit_key, actor_id, actor_handle,
        title, body, content_hash, extracted, trust, raw, created_at)
      values ('o1', 'github', 'acme/repo#1', 'issue', 'github:acme/repo#1', '1', 'alice',
        'Bug', 'Body', 'hash-1', '{}'::jsonb, 'internal', '{}'::jsonb, now())
    `)
    const rows = await claimOutbox(handle.db, 'worker', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('inngest_event')
    expect(rows[0]?.payload).toMatchObject({ name: 'event/received', data: { orgId: 'o1' } })
  })
})
