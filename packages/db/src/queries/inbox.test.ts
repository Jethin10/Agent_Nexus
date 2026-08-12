import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalize, type RawEvent } from '@ascendant/core'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '../local'
import type { Db } from '../client'
import { insertEvent } from './events'
import { inbox, insertDecision } from './decisions'

const ORG = 'org_inbox_test'

function event(sourceRef: string, title: string, createdAt: Date): RawEvent {
  return {
    orgId: ORG,
    source: 'github',
    kind: 'issue',
    sourceRef,
    threadKey: null,
    actor: { id: '1', handle: 'alice', isBot: false },
    title,
    body: `${title} body`,
    createdAt,
    attachments: [],
    raw: null,
  }
}

describe('inbox query', () => {
  let handle: LocalDbHandle
  let database: Db

  beforeAll(async () => {
    handle = await makeLocalDb()
    database = handle.db
    await applyMigrations(handle.db)

    await insertEvent(database, normalize(event('acme/api#1', 'Needle in the oldest issue', new Date('2026-01-01'))))
    await insertEvent(database, normalize(event('acme/api#2', 'Middle issue', new Date('2026-02-01'))))
    await insertEvent(database, normalize(event('acme/api#3', 'Newest issue', new Date('2026-03-01'))))
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
  })

  it('filters before applying the result limit', async () => {
    const rows = await inbox(database, ORG, { query: 'needle', limit: 1 })
    expect(rows.map((row) => row.sourceRef)).toEqual(['acme/api#1'])
  })

  it('orders the complete result set before applying the result limit', async () => {
    const oldest = await inbox(database, ORG, { order: 'oldest', limit: 1 })
    const newest = await inbox(database, ORG, { order: 'newest', limit: 1 })

    expect(oldest[0]?.sourceRef).toBe('acme/api#1')
    expect(newest[0]?.sourceRef).toBe('acme/api#3')
  })

  it('returns only the latest immutable decision after a human correction', async () => {
    const rows = await inbox(database, ORG, { query: 'Middle issue' })
    const middle = rows[0]
    if (!middle) throw new Error('middle event missing')

    const base = {
      orgId: ORG,
      eventId: middle.eventId,
      confidence: 0.7,
      citations: [{ kind: 'doc' as const, ref: 'doc:test', quote: 'evidence', why: 'test' }],
      policyHits: [] as string[],
      autonomous: false,
      needsReview: false,
      tokens: 0,
      latencyMs: 0,
    }
    await insertDecision(database, {
      ...base,
      outcome: 'ESCALATE',
      reasoning: 'Model asked for a human.',
      modelUsed: 'fixture:triage',
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await insertDecision(database, {
      ...base,
      outcome: 'ACCEPT',
      confidence: 1,
      reasoning: 'Human accepted it.',
      modelUsed: 'human:reviewer',
    })

    const corrected = await inbox(database, ORG, { query: 'Middle issue' })
    expect(corrected).toHaveLength(1)
    expect(corrected[0]?.outcome).toBe('ACCEPT')
    expect(corrected[0]?.modelUsed).toBe('human:reviewer')
  })
})
