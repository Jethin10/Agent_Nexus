import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalize, type RawEvent } from '@ascendant/core'
import { insertEvent } from '@ascendant/db'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '@ascendant/db/local'
import { resetScenarios } from './context.ts'

/**
 * `resetScenarios` against a real Postgres.
 *
 * It deletes rows and builds its `in (...)` list at runtime, which is the combination
 * worth pinning: an earlier version interpolated each ref as a quoted SQL literal with
 * hand-rolled `''` escaping. Every ref currently comes from `fixtures.ts` so nothing was
 * exploitable, but the escaping was the only thing standing between a ref and arbitrary
 * SQL, and refs are plain strings that a CLI argument could supply tomorrow.
 *
 * The scoping assertions matter as much as the injection one: this runs with `--fresh` on
 * a database holding the corpus the gate reasons against, so deleting one row too many is
 * how a demo silently loses its evidence and collapses every refusal to ESCALATE.
 */

const ORG = 'org_reset_test'
const OTHER_ORG = 'org_reset_other'

let handle: LocalDbHandle

function raw(sourceRef: string, orgId = ORG): RawEvent {
  return {
    orgId,
    source: 'github',
    kind: 'issue',
    sourceRef,
    threadKey: null,
    actor: { id: '1', handle: 'someone', isBot: false },
    title: `Issue ${sourceRef}`,
    body: 'body',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    attachments: [],
    raw: null,
  }
}

async function seed(sourceRef: string, orgId = ORG): Promise<void> {
  await insertEvent(handle.db, normalize(raw(sourceRef, orgId), {}))
}

async function refsIn(orgId: string): Promise<string[]> {
  const res = await handle.client.query<{ source_ref: string }>(
    'select source_ref from events where org_id = $1 order by source_ref',
    [orgId],
  )
  return res.rows.map((r) => r.source_ref)
}

beforeAll(async () => {
  handle = await makeLocalDb()
  await applyMigrations(handle.db)
}, 120_000)

afterAll(async () => {
  await handle?.close?.()
})

describe('resetScenarios', () => {
  it('deletes only the refs it was given', async () => {
    await seed('acme/api#1')
    await seed('acme/api#2')
    await seed('acme/api#3')

    const deleted = await resetScenarios(handle, ORG, ['acme/api#1', 'acme/api#3'])

    expect(deleted).toBe(2)
    expect(await refsIn(ORG)).toEqual(['acme/api#2'])
  })

  it('never touches another org', async () => {
    await seed('shared#9')
    await seed('shared#9', OTHER_ORG)

    const deleted = await resetScenarios(handle, ORG, ['shared#9'])

    expect(deleted).toBe(1)
    expect(await refsIn(OTHER_ORG)).toEqual(['shared#9'])
  })

  it('is a no-op on an empty list rather than deleting everything', async () => {
    await seed('keep#1')
    const before = await refsIn(ORG)

    expect(await resetScenarios(handle, ORG, [])).toBe(0)
    expect(await refsIn(ORG)).toEqual(before)
  })

  it('treats a quote-bearing ref as data, not SQL', async () => {
    const hostile = "acme/api#1'; drop table events; --"
    await seed(hostile)
    await seed('bystander#1')

    const deleted = await resetScenarios(handle, ORG, [hostile])

    expect(deleted).toBe(1)
    // The table still exists and the neighbour survived — the payload never parsed.
    expect(await refsIn(ORG)).toContain('bystander#1')
  })

  it('reports a ref that matched nothing without failing', async () => {
    expect(await resetScenarios(handle, ORG, ['never/ingested#404'])).toBe(0)
  })
})
