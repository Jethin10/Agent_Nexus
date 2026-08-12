import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalize, type RawEvent } from '@ascendant/core'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '../local'
import type { Db } from '../client'
import { decisionForEvent, insertDecision } from './decisions'
import { insertEvent } from './events'
import { applyHumanReview } from './human-review'
import { overturnForDecision } from './metrics'

const ORG = 'org_human_review'

function raw(ref: string): RawEvent {
  return {
    orgId: ORG,
    source: 'github',
    kind: 'issue',
    sourceRef: ref,
    threadKey: null,
    actor: { id: '1', handle: 'alice', isBot: false },
    title: 'A bounded bug',
    body: 'A detailed report with a reproducible failure and stack trace.',
    createdAt: new Date(),
    attachments: [],
    raw: null,
  }
}

describe('applyHumanReview', () => {
  let handle: LocalDbHandle
  let database: Db

  beforeAll(async () => {
    handle = await makeLocalDb()
    database = handle.db
    await applyMigrations(handle.db)
  }, 120_000)

  afterAll(async () => handle?.close())

  it('appends a human ACCEPT, records the overturn, and opens the gate-owned ticket once', async () => {
    const event = (await insertEvent(database, normalize(raw('acme/api#human-1')))).row
    const decision = await insertDecision(database, {
      orgId: ORG,
      eventId: event.id,
      outcome: 'ESCALATE',
      confidence: 0.4,
      reasoning: 'A human must decide.',
      citations: [{ kind: 'doc', ref: 'doc:policy', quote: 'review it', why: 'low confidence' }],
      policyHits: [],
      autonomous: false,
      needsReview: false,
      modelUsed: 'fixture:triage',
    })

    const first = await applyHumanReview(database, {
      orgId: ORG,
      eventId: event.id,
      decisionId: decision.id,
      outcome: 'ACCEPT',
      actor: 'maya',
      reason: 'I reproduced it.',
      surface: 'dashboard',
    })
    const second = await applyHumanReview(database, {
      orgId: ORG,
      eventId: event.id,
      decisionId: decision.id,
      outcome: 'ACCEPT',
      actor: 'maya',
      surface: 'dashboard',
    })

    expect(first.status).toBe('overturned')
    expect(first.ticketId).toBeTruthy()
    expect(second.status).toBe('already_reviewed')
    expect(second.ticketId).toBe(first.ticketId)
    expect((await decisionForEvent(database, ORG, event.id))?.modelUsed).toBe('human:maya')
    expect((await overturnForDecision(database, ORG, decision.id))?.toOutcome).toBe('ACCEPT')
  })

  it('records a confirmation without inventing a replacement decision', async () => {
    const event = (await insertEvent(database, normalize(raw('acme/api#human-2')))).row
    const decision = await insertDecision(database, {
      orgId: ORG,
      eventId: event.id,
      outcome: 'REJECT',
      confidence: 0.9,
      reasoning: 'The ADR rules this out.',
      citations: [{ kind: 'doc', ref: 'doc:adr', quote: 'do not build', why: 'binding decision' }],
      policyHits: [],
      autonomous: true,
      needsReview: false,
      modelUsed: 'fixture:triage',
    })

    const result = await applyHumanReview(database, {
      orgId: ORG,
      eventId: event.id,
      decisionId: decision.id,
      outcome: 'REJECT',
      actor: 'maya',
      surface: 'slack',
    })

    expect(result.status).toBe('confirmed')
    expect((await decisionForEvent(database, ORG, event.id))?.id).toBe(decision.id)
    expect(await overturnForDecision(database, ORG, decision.id)).toBeUndefined()
  })
})
