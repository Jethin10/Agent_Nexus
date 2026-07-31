import {
  db,
  decisionForEvent,
  finishRun,
  getEvent,
  insertDecision,
  loadPolicyContext,
  openTicketForAccept,
  recordOutcome,
  recordOverturn,
  retrieveCandidates,
  startRun,
  threadBody,
  trace,
} from '@ascendant/db'
import { NoCapacityError } from '@ascendant/router'
import { triage } from '@ascendant/agents'
import { NormalizedEvent, decide, type Candidate } from '@ascendant/core'
import { inngest } from './events.js'
import { flushTraces, openRun } from './runtime.js'

/**
 * Function 2 of 5 — `triage`. The thesis, wired up.
 *
 * The whole gate is a pure function (`@ascendant/agents`); this function's job is
 * only to feed it and to persist what it decides. Four of the five outcomes end
 * here, which is the point: most work never reaches the pipeline at all.
 *
 * `work/accepted` is emitted on exactly one path — an ACCEPT that opened a ticket.
 */

/** The event row, rebuilt into the shape the pure agent expects. */
function toNormalized(row: Awaited<ReturnType<typeof getEvent>>, body?: string): NormalizedEvent {
  if (!row) throw new Error('toNormalized: no row')
  return NormalizedEvent.parse({
    id: row.id,
    orgId: row.orgId,
    source: row.source,
    sourceRef: row.sourceRef,
    kind: row.kind,
    threadKey: row.threadKey,
    actor: { id: row.actorId, handle: row.actorHandle, isBot: row.actorIsBot },
    title: row.title,
    body: body ?? row.body,
    createdAt: row.createdAt,
    attachments: row.attachments,
    contentHash: row.contentHash,
    extracted: row.extracted,
    trust: row.trust,
    injectionSuspected: row.injectionSuspected,
    raw: null,
  })
}

/** DEFER and ESCALATE wait up to 72h for a human (§4.3). Free tier allows 7 days. */
const HUMAN_WAIT = '72h'

export const triageFn = inngest.createFunction(
  {
    id: 'triage',
    name: 'Triage Gate',
    concurrency: { limit: 3 },
    retries: 2,
  },
  { event: 'triage/requested' },
  async ({ event, step, runId }) => {
    const { orgId, eventId } = event.data

    const run = await step.run('open-run', async () => {
      const r = await startRun(db(), { orgId, fn: 'triage', inngestRunId: runId, meta: { eventId } })
      return { id: r.id }
    })

    /**
     * A redelivered webhook that slipped past the unique index must not be triaged
     * twice: the decision row is immutable, and a second run would double-spend the
     * token budget and could post a duplicate comment on the issue.
     */
    const existing = await step.run('check-existing', async () => {
      const d = await decisionForEvent(db(), orgId, eventId)
      return d ? { decisionId: d.id, outcome: d.outcome } : null
    })
    if (existing) {
      await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
      return { ...existing, alreadyDecided: true }
    }

    // ── the deterministic stage, then retrieval, then the model ────────────────
    const decided = await step.run('decide', async () => {
      const ctx = await openRun({ orgId, runId: run.id })
      const row = await getEvent(ctx.db, orgId, eventId)
      if (!row) throw new Error(`triage: event ${eventId} not found`)

      // §7.3: a 30-comment issue is ONE unit of work, so the gate reads the whole
      // reconstructed thread rather than being run once per comment.
      const body = row.threadKey ? await threadBody(ctx.db, orgId, row.unitKey) : row.body
      const normalized = toNormalized(row, body)

      const policyCtx = await loadPolicyContext(ctx.db, normalized, ctx.policy.botHandles)
      const verdict = decide(normalized, policyCtx)

      /**
       * Retrieval is skipped when a rule already decided: the outcome is mechanical
       * and four queries would buy nothing. This is the cost story in §5.2 made
       * literal — noise costs zero tokens and zero database round trips.
       */
      let candidates: readonly Candidate[] = []
      let degraded: string[] = []
      if (!verdict.decided) {
        const r = await retrieveCandidates(ctx.db, { orgId, event: normalized })
        candidates = r.candidates
        degraded = r.degraded
        await trace(ctx.db, {
          orgId,
          runId: run.id,
          agent: 'triage',
          phase: 'retrieved',
          summary: `${r.candidates.length} candidates (${Object.entries(r.bySource)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}:${n}`)
            .join(' ')}) ~${r.tokens} tokens`,
          detail: { bySource: r.bySource, dropped: r.dropped, degraded: r.degraded },
        })
      }

      try {
        const result = await triage(ctx.agent, {
          event: normalized,
          candidates,
          policy: verdict,
          bands: ctx.policy.bands,
        })

        const decision = await insertDecision(ctx.db, {
          orgId,
          eventId,
          outcome: result.outcome,
          confidence: result.confidence,
          reasoning: result.reasoning,
          citations: result.citations as never,
          mergeTargetId: result.mergeTargetId,
          missingInfo: result.missingInfo,
          policyHits: result.policyHits,
          modelSelfReport: result.components.modelSelfReport,
          evidenceStrength: result.components.evidenceStrength,
          policyAgreement: result.components.policyAgreement,
          autonomous: result.autonomous,
          needsReview: result.needsReview,
          modelUsed: result.cost.model,
          tokens: result.cost.tokens,
          latencyMs: result.cost.latencyMs,
        })

        await flushTraces(ctx, { runId: run.id })

        return {
          decisionId: decision.id,
          outcome: result.outcome,
          confidence: result.confidence,
          autonomous: result.autonomous,
          decidedByPolicy: result.decidedByPolicy,
          title: row.title,
          reasoning: result.reasoning,
          degraded,
        }
      } catch (err) {
        /**
         * §10.1: every rung exhausted is an ESCALATE with `reason: 'no_capacity'`,
         * never a silent failure and never a crash that loses the event. Degradation
         * is a first-class outcome — the system's failure mode is always "hand it to
         * a human with everything we learned".
         */
        const noCapacity = err instanceof NoCapacityError
        const budgetHit = err instanceof Error && err.name === 'BudgetExceededError'
        if (!noCapacity && !budgetHit) throw err

        const reason = noCapacity ? 'no_capacity' : 'budget_exceeded'
        const decision = await insertDecision(ctx.db, {
          orgId,
          eventId,
          outcome: 'ESCALATE',
          confidence: 0,
          reasoning: `Ascendant could not reach a decision autonomously: ${reason}. ${
            err instanceof Error ? err.message : ''
          } Routing to a human with the full context attached rather than guessing.`,
          citations: [
            {
              kind: 'doc',
              ref: `system:${reason}`,
              quote: err instanceof Error ? err.message.slice(0, 400) : reason,
              why: 'The router exhausted every available model tier for this task.',
            },
          ] as never,
          policyHits: verdict.ruleIds,
          autonomous: false,
          needsReview: false,
          modelUsed: reason,
        })

        await trace(ctx.db, {
          orgId,
          runId: run.id,
          agent: 'triage',
          phase: 'escalated',
          summary: `ESCALATE (${reason}) — no autonomous decision was possible`,
          detail: {
            reason,
            attempts: noCapacity ? (err as NoCapacityError).attempts : undefined,
          },
        })
        await flushTraces(ctx, { runId: run.id })

        return {
          decisionId: decision.id,
          outcome: 'ESCALATE' as const,
          confidence: 0,
          autonomous: false,
          decidedByPolicy: false,
          title: row.title,
          reasoning: reason,
          degraded,
        }
      }
    })

    // ── ACCEPT is the only path into the work pipeline ─────────────────────────
    if (decided.outcome === 'ACCEPT') {
      const ticket = await step.run('open-ticket', async () => {
        const database = db()
        const decision = await decisionForEvent(database, orgId, eventId)
        if (!decision) throw new Error('triage: decision vanished between steps')
        const t = await openTicketForAccept(database, {
          orgId,
          decision,
          title: decided.title,
          statement: decided.reasoning,
        })
        return { id: t.id }
      })

      await step.sendEvent('start-work', {
        name: 'work/accepted',
        data: { orgId, ticketId: ticket.id, decisionId: decided.decisionId },
      })
      await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
      return { ...decided, ticketId: ticket.id }
    }

    /**
     * DEFER and ESCALATE park on a `waitForEvent` rather than closing. A parked run
     * holds no concurrency slot, so a stalled ticket cannot starve the other four
     * (§4.3). Timeout auto-closes with a comment: no orphaned tickets, ever.
     */
    if (decided.outcome === 'DEFER' || decided.outcome === 'ESCALATE') {
      const resolution = await step.waitForEvent('await-human', {
        event: 'human/resolved',
        timeout: HUMAN_WAIT,
        if: `async.data.eventId == "${eventId}"`,
      })

      await step.run('record-resolution', async () => {
        const database = db()
        if (!resolution) {
          await trace(database, {
            orgId,
            runId: run.id,
            agent: 'orchestrator',
            phase: 'timed_out',
            summary: `No human response in ${HUMAN_WAIT}; auto-closing this ${decided.outcome}`,
            detail: { eventId, decisionId: decided.decisionId },
          })
          await recordOutcome(database, {
            orgId,
            decisionId: decided.decisionId,
            kind: 'human_timeout',
          })
          return
        }
        await trace(database, {
          orgId,
          runId: run.id,
          agent: 'orchestrator',
          phase: 'human_resolved',
          summary: `@${resolution.data.actor} resolved this ${decided.outcome} as ${resolution.data.outcome}`,
          detail: { ...resolution.data },
        })
      })

      /**
       * A human turning a DEFER or ESCALATE into ACCEPT still has to go through the
       * gate's door — `openTicketForAccept` refuses any decision that is not an
       * ACCEPT — so a second decision row is written attributing the human, and the
       * disagreement is recorded as an `overturns` row (§11.3).
       *
       * Re-emitting `triage/requested` would NOT work here: the new run's
       * check-existing step would find this decision and return early. The human's
       * judgement is the new evidence, so it is recorded rather than re-derived.
       */
      if (resolution && resolution.data.outcome !== decided.outcome) {
        const escalated = await step.run('apply-human-decision', async () => {
          const database = db()
          await recordOverturn(database, {
            orgId,
            decisionId: decided.decisionId,
            fromOutcome: decided.outcome,
            toOutcome: resolution.data.outcome,
            actor: resolution.data.actor,
            reason: resolution.data.reason,
          })

          if (resolution.data.outcome !== 'ACCEPT') return null

          const row = await getEvent(database, orgId, eventId)
          const decision = await insertDecision(database, {
            orgId,
            eventId,
            outcome: 'ACCEPT',
            confidence: 1,
            reasoning: `@${resolution.data.actor} reviewed Ascendant's ${decided.outcome} and accepted this as real work.${
              resolution.data.reason ? ` They noted: ${resolution.data.reason}` : ''
            }`,
            citations: [
              {
                kind: 'ticket',
                ref: `decision:${decided.decisionId}`,
                quote: decided.reasoning.slice(0, 400),
                why: `A human overturned this ${decided.outcome}.`,
              },
            ] as never,
            policyHits: [],
            /** A human decision is not an autonomous one: it is excluded from the
             *  triage-precision denominator by construction. */
            autonomous: false,
            needsReview: false,
            modelUsed: `human:${resolution.data.actor}`,
          })

          const ticket = await openTicketForAccept(database, {
            orgId,
            decision,
            title: row?.title ?? decided.title,
            statement: decision.reasoning,
          })
          return { ticketId: ticket.id, decisionId: decision.id }
        })

        if (escalated) {
          await step.sendEvent('start-work', {
            name: 'work/accepted',
            data: { orgId, ticketId: escalated.ticketId, decisionId: escalated.decisionId },
          })
          await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
          return { ...decided, ticketId: escalated.ticketId, humanAccepted: true }
        }
      }
    }

    await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
    return decided
  },
)
