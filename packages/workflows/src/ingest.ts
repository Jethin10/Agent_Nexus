import { db, finishRun, getEvent, startRun, trace } from '@ascendant/db'
import { inngest } from './events.js'

/**
 * Function 1 of 5 — `ingest`, triggered by `event/received`.
 *
 * The row is already written by the webhook handler: on Vercel Hobby a function is
 * capped at 60s, so the handler's only job is verify → insert → emit → 200 (§13.3).
 * This function therefore does not re-insert; it confirms the row exists and hands
 * off to triage.
 *
 * That split matters for a reason beyond the timeout: the insert must happen inside
 * the request that authenticated the signature. If ingestion were deferred to here,
 * a dropped Inngest event would silently lose a webhook GitHub already considers
 * delivered, and there is no redelivery to recover it.
 */
export const ingestFn = inngest.createFunction(
  {
    id: 'ingest',
    name: 'Ingest event',
    /** Five concurrent executions is the whole free-tier budget (§6). */
    concurrency: { limit: 3 },
    retries: 2,
  },
  { event: 'event/received' },
  async ({ event, step, runId }) => {
    const { orgId, eventId } = event.data

    const run = await step.run('open-run', async () => {
      const r = await startRun(db(), {
        orgId,
        fn: 'ingest',
        inngestRunId: runId,
        meta: { eventId, source: event.data.source, sourceRef: event.data.sourceRef },
      })
      return { id: r.id }
    })

    const found = await step.run('confirm-event', async () => {
      const row = await getEvent(db(), orgId, eventId)
      if (!row) return { ok: false as const }

      await trace(db(), {
        orgId,
        runId: run.id,
        agent: 'orchestrator',
        phase: 'ingested',
        summary: `${row.source}:${row.kind} ${row.sourceRef} from @${row.actorHandle} (trust: ${row.trust})`,
        detail: {
          eventId,
          contentHash: row.contentHash,
          injectionSuspected: row.injectionSuspected,
          symbols: row.extracted.symbols.slice(0, 10),
        },
      })
      return { ok: true as const, injectionSuspected: row.injectionSuspected }
    })

    if (!found.ok) {
      // The webhook handler is the only writer, so a missing row means the emit
      // outran its own transaction. Fail loudly rather than triaging nothing.
      await step.run('fail-missing', () =>
        finishRun(db(), orgId, run.id, 'failed', { error: `event ${eventId} not found` }),
      )
      throw new Error(`ingest: event ${eventId} not found for org ${orgId}`)
    }

    await step.sendEvent('request-triage', {
      name: 'triage/requested',
      data: { orgId, eventId },
    })

    await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))

    return { eventId, injectionSuspected: found.injectionSuspected }
  },
)
