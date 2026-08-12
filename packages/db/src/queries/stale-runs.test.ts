import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '../local'
import { failStaleRuns, startRun } from './trace'
import { runs } from '../schema/runs'
import { eq } from 'drizzle-orm'

let handle: LocalDbHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

describe('stale run reconciliation', () => {
  it('fails abandoned work but preserves triage runs parked for a human', async () => {
    handle = await makeLocalDb()
    await applyMigrations(handle.db)
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const coded = await startRun(handle.db, { orgId: 'org_live', fn: 'plan-and-code' })
    const waiting = await startRun(handle.db, { orgId: 'org_live', fn: 'triage' })
    await handle.db.update(runs).set({ startedAt: old }).where(eq(runs.orgId, 'org_live'))

    const reconciled = await failStaleRuns(
      handle.db,
      'org_live',
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    )
    expect(reconciled.map((run) => run.id)).toEqual([coded.id])

    const rows = await handle.db.select().from(runs)
    expect(rows.find((run) => run.id === coded.id)).toMatchObject({
      status: 'failed',
      error: 'stale_run_reconciled',
    })
    expect(rows.find((run) => run.id === waiting.id)?.status).toBe('running')
  }, 15_000)
})
