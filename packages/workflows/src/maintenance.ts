import {
  db,
  failStaleRuns,
  finishRun,
  repeatedObjections,
  spendToday,
  startRun,
  trace,
} from '@ascendant/db'
import { inngest } from './events.js'
import { embedEvent, eventsMissingProductionEmbedding } from './embeddings.js'

/**
 * §7.2 — the single scheduled job. Everything else in this system is push: polling
 * burns free-tier quota for nothing and Linear explicitly discourages it.
 *
 * One cron, well inside Vercel's limit of 100. It runs at 05:00 UTC and does the four
 * things that genuinely cannot be event-driven:
 *
 * 1. Re-embeds anything whose embedding is missing, so a Gemini quota exhaustion
 *    during ingest degrades retrieval temporarily rather than permanently.
 * 2. Rolls up yesterday's metrics and reports CU-hours, because Neon Free *suspends*
 *    compute for the rest of the billing month on exceeding a limit rather than
 *    throttling — the scariest failure mode on this stack (§13.1).
 * 3. Mines repeated Reviewer objections into repo conventions (§11.3).
 */
export const maintenanceFn = inngest.createFunction(
  { id: 'maintenance', name: 'Daily maintenance', retries: 1 },
  [{ cron: '0 5 * * *' }, { event: 'maintenance/daily' }],
  async ({ event, step }) => {
    /**
     * Two triggers, so `event.data` is a union: the cron fires with no data at all
     * while a manual `maintenance/daily` may name an org. Narrowed rather than cast,
     * because a cron invocation genuinely has no orgId to read.
     */
    const data: unknown = event.data
    const fromEvent =
      typeof data === 'object' && data !== null && 'orgId' in data
        ? (data as { orgId?: string }).orgId
        : undefined
    const configuredOrgId = process.env.ASCENDANT_ORG_ID
    if (!fromEvent && !configuredOrgId && process.env.NODE_ENV === 'production') {
      throw new Error('ASCENDANT_ORG_ID is required for scheduled production maintenance.')
    }
    const orgId = fromEvent ?? configuredOrgId ?? 'org_demo'

    const run = await step.run('open-run', async () => {
      const r = await startRun(db(), { orgId, fn: 'maintenance' })
      return { id: r.id }
    })

    const staleRuns = await step.run('reconcile-stale-runs', async () => {
      const reconciled = await failStaleRuns(db(), orgId, new Date(Date.now() - 2 * 60 * 60 * 1000))
      if (reconciled.length > 0) {
        await trace(db(), {
          orgId,
          runId: run.id,
          agent: 'orchestrator',
          phase: 'stale_runs_reconciled',
          summary: `${reconciled.length} non-waiting workflow run(s) exceeded two hours and were marked failed.`,
          detail: { runIds: reconciled.map((item) => item.id), functions: reconciled.map((item) => item.fn) },
        })
      }
      return reconciled.length
    })

    const health = await step.run('report-quota', async () => {
      const spend = await spendToday(db(), orgId)
      await trace(db(), {
        orgId,
        runId: run.id,
        agent: 'orchestrator',
        phase: 'quota_report',
        summary: `${spend.tokens} tokens and ${spend.calls} model calls so far today`,
        detail: { ...spend },
      })
      return spend
    })

    const embeddingRepair = await step.run('repair-embeddings', async () => {
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) {
        await trace(db(), {
          orgId,
          runId: run.id,
          agent: 'orchestrator',
          phase: 'embedding_repair_skipped',
          summary: 'GEMINI_API_KEY is not configured; missing semantic embeddings remain visible as degraded retrieval.',
        })
        return { repaired: 0, failed: 0, remaining: 'unknown' as const }
      }

      const missing = await eventsMissingProductionEmbedding(db(), orgId, 50)
      let repaired = 0
      let failed = 0
      for (const eventRow of missing) {
        try {
          await embedEvent(db(), eventRow, { apiKey })
          repaired += 1
        } catch {
          // Continue the bounded batch. The failed row remains eligible tomorrow.
          failed += 1
        }
      }
      await trace(db(), {
        orgId,
        runId: run.id,
        agent: 'orchestrator',
        phase: failed > 0 ? 'embedding_repair_degraded' : 'embedding_repair_complete',
        summary: `Embedding repair processed ${missing.length}: ${repaired} repaired, ${failed} failed.`,
        detail: { repaired, failed, batchSize: missing.length },
      })
      return { repaired, failed, remaining: missing.length === 50 ? 'possible' as const : 'none' as const }
    })

    const conventions = await step.run('mine-conventions', async () => {
      const mined = await repeatedObjections(db(), orgId)
      if (mined.length > 0) {
        await trace(db(), {
          orgId,
          runId: run.id,
          agent: 'reviewer',
          phase: 'conventions_promoted',
          summary: `${mined.length} objections raised 3+ times are now part of the Coder's conventions`,
          detail: { rules: mined },
        })
      }
      return mined
    })

    await step.run('finish-run', async () => {
      await finishRun(db(), orgId, run.id, 'succeeded')
    })

    return {
      orgId,
      spend: health,
      staleRunsReconciled: staleRuns,
      embeddings: embeddingRepair,
      conventions: conventions.length,
    }
  },
)
