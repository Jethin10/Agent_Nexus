import {
  applyHumanReview,
  db,
  decisionForEvent,
  finishRun,
  getEvent,
  insertDecision,
  loadPolicyContext,
  openTicketForAccept,
  recordOutcome,
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
import { githubWriter } from './github-write.js'
import { repoFromEnv } from './repo.js'
import {
  createLinearWorkItem,
  linearFromEnv,
  notifySlack,
  slackFromEnv,
} from './notify.js'
import { updateTicket } from './tickets.js'
import { embedEvent, embedText, eventEmbeddingContent } from './embeddings.js'

/**
 * Function 2 of 5 — `triage`. The thesis, wired up.
 *
 * The whole gate is a pure function (`@ascendant/agents`); this function's job is
 * only to feed it and to persist what it decides. Four of the five outcomes end
 * here, which is the point: most work never reaches the pipeline at all.
 *
 * `work/accepted` is emitted on exactly one path — an ACCEPT that opened a ticket.
 */

/**
 * The event row, rebuilt into the shape the pure agent expects.
 *
 * Exported because this is the one place that knows how a flat `EventRow` maps onto
 * the nested `NormalizedEvent` — `actorId`/`actorHandle`/`actorIsBot` collapse into
 * `actor`, and getting that wrong produces an event that typechecks through a cast
 * and then throws inside the policy rules. Any caller replaying a stored row (the
 * demo runner, an eval harness) must go through here rather than casting.
 *
 * `raw` is deliberately dropped: the agents never read it, and it can be 64 KiB.
 */
export function toNormalized(
  row: Awaited<ReturnType<typeof getEvent>>,
  body?: string,
): NormalizedEvent {
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
        let queryVector: number[] | undefined
        if (process.env.GEMINI_API_KEY) {
          try {
            // Store the event as a retrieval document, but search with a query vector.
            // Google tunes those task types differently; mixing them weakens ranking.
            await embedEvent(ctx.db, row, { apiKey: process.env.GEMINI_API_KEY })
            queryVector = await embedText({
              apiKey: process.env.GEMINI_API_KEY,
              text: eventEmbeddingContent(row),
              task: 'RETRIEVAL_QUERY',
            })
          } catch (err) {
            degraded.push('embedding:provider')
            await trace(ctx.db, {
              orgId,
              runId: run.id,
              agent: 'triage',
              phase: 'embedding_degraded',
              summary: `Semantic retrieval unavailable: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        } else {
          degraded.push('embedding:not_configured')
        }

        const r = await retrieveCandidates(ctx.db, {
          orgId,
          event: normalized,
          ...(queryVector ? { vec: queryVector, dim: 768 as const } : {}),
        })
        degraded.push(...r.degraded)
        candidates = r.candidates
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
          statement: `${row.title}\n\n${body}`,
          reasoning: result.reasoning,
          citations: result.citations,
          mergeTargetId: result.mergeTargetId ?? null,
          missingInfo: result.missingInfo ?? [],
          source: row.source,
          sourceRef: row.sourceRef,
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
          statement: `${row.title}\n\n${body}`,
          reasoning: reason,
          citations: decision.citations,
          mergeTargetId: null,
          missingInfo: [],
          source: row.source,
          sourceRef: row.sourceRef,
          degraded,
        }
      }
    })

    // Close the loop at the source. These are best-effort side effects: the immutable
    // decision is already safe in Postgres, so a provider outage is traced rather than
    // erasing the judgement or crashing the pipeline.
    await step.run('respond-at-source', async () => {
      const failures: string[] = []
      let githubFailed = false
      let repo: Awaited<ReturnType<typeof repoFromEnv>>
      try {
        repo = await repoFromEnv()
      } catch (err) {
        // The immutable decision is already persisted. Authentication failure degrades
        // the source response; it must not erase or repeatedly re-run the judgement.
        githubFailed = true
        failures.push(`GitHub authentication: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (repo && decided.source === 'github' && isConfiguredIssueRef(decided.sourceRef, repo)) {
        const writer = githubWriter(repo)
        try {
          await writer.comment(decided.sourceRef, githubDecisionComment(decided))
          if (decided.outcome === 'REJECT' && decided.autonomous) {
            await writer.closeIssue(decided.sourceRef, 'not_planned')
          } else if (decided.outcome === 'MERGE' && decided.autonomous) {
            await writer.closeIssue(decided.sourceRef, 'not_planned')
          }
          await writer.label(decided.sourceRef, [`ascendant:${decided.outcome.toLowerCase()}`])
        } catch (err) {
          githubFailed = true
          failures.push(`GitHub: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (decided.outcome === 'DEFER' || decided.outcome === 'ESCALATE') {
        const slack = await notifySlack(slackFromEnv(), {
          text: slackDecisionSummary(decided),
          decisionId: decided.decisionId,
        })
        if (slack.status === 'failed') failures.push(`Slack: ${slack.reason}`)
      }

      await trace(db(), {
        orgId,
        runId: run.id,
        agent: 'delivery',
        phase: failures.length ? 'source_response_degraded' : 'source_responded',
        summary: failures.length
          ? `Decision persisted; ${failures.length} outbound action${failures.length > 1 ? 's' : ''} failed.`
          : 'Source response completed or was not configured for this event.',
        detail: { failures },
      })
      if (githubFailed) {
        // GitHub comments are content-idempotent and labels/closes are idempotent, so
        // Inngest can safely retry this step after an API outage.
        throw new Error(failures.filter((failure) => failure.startsWith('GitHub')).join('; '))
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
          statement: decided.statement,
        })
        return { id: t.id }
      })

      await step.run('connect-work-tracking', async () => {
        const linear = await createLinearWorkItem(linearFromEnv(), {
          title: decided.title,
          description: `${decided.statement}\n\nAscendant decision:\n${decided.reasoning}`,
          decisionId: decided.decisionId,
        })
        if (linear.status === 'ok') {
          const detail = linear.detail as { id?: string; identifier?: string }
          await updateTicket(db(), orgId, ticket.id, {
            linearId: detail.id ?? null,
            linearIdentifier: detail.identifier ?? null,
          })
        }

        const slack = await notifySlack(slackFromEnv(), {
          text: `*ACCEPT* — ${decided.title}\n${decided.reasoning}`,
          decisionId: decided.decisionId,
        })
        if (slack.status === 'ok') {
          const detail = slack.detail as { channel?: string; ts?: string }
          await updateTicket(db(), orgId, ticket.id, {
            slackChannel: detail.channel ?? null,
            slackTs: detail.ts ?? null,
          })
        }

        await trace(db(), {
          orgId,
          ticketId: ticket.id,
          runId: run.id,
          agent: 'orchestrator',
          phase: 'work_tracking_connected',
          summary: `Work tracking: Linear ${linear.status}, Slack ${slack.status}.`,
          detail: { linear, slack },
        })
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

      if (resolution) {
        const reviewed = await step.run('apply-human-decision', () =>
          applyHumanReview(db(), {
            orgId,
            eventId,
            decisionId: decided.decisionId,
            outcome: resolution.data.outcome,
            actor: resolution.data.actor,
            reason: resolution.data.reason,
            surface: 'slack',
          }),
        )

        if (reviewed.ticketId && reviewed.outcome === 'ACCEPT') {
          await step.sendEvent('start-work', {
            name: 'work/accepted',
            data: { orgId, ticketId: reviewed.ticketId, decisionId: reviewed.decisionId },
          })
          await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
          return { ...decided, ticketId: reviewed.ticketId, humanAccepted: true }
        }
      }
    }

    await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
    return decided
  },
)

interface OutboundDecision {
  decisionId: string
  title: string
  outcome: 'ACCEPT' | 'REJECT' | 'MERGE' | 'DEFER' | 'ESCALATE'
  confidence: number
  reasoning: string
  citations: readonly { ref: string; quote: string }[]
  mergeTargetId: string | null
  missingInfo: readonly string[]
  autonomous: boolean
}

export function githubDecisionComment(decision: OutboundDecision): string {
  const evidence = decision.citations
    .map((c) => `- \`${c.ref}\`: “${c.quote}”`)
    .join('\n')
  const extras = [
    decision.mergeTargetId ? `\n**Merge target:** \`${decision.mergeTargetId}\`` : '',
    decision.missingInfo.length
      ? `\n**Information needed:**\n${decision.missingInfo.map((q) => `- ${q}`).join('\n')}`
      : '',
  ].join('')
  return [
    `## Ascendant decision: ${decision.outcome}`,
    '',
    `${Math.round(decision.confidence * 100)}% confidence · ${decision.autonomous ? 'autonomous' : 'human review required'}`,
    '',
    decision.reasoning,
    '',
    '**Verified evidence**',
    evidence || '- No external evidence was attached.',
    extras,
    '',
    `Decision id: \`${decision.decisionId}\``,
  ].join('\n')
}

export function slackDecisionSummary(decision: OutboundDecision): string {
  const questions = decision.missingInfo.length
    ? `\n${decision.missingInfo.map((q) => `• ${q}`).join('\n')}`
    : ''
  return `*${decision.outcome}* · ${Math.round(decision.confidence * 100)}% — ${decision.title}\n${decision.reasoning}${questions}`
}

/** Do not let a token for one repository mutate an issue from another repository. */
export function isConfiguredIssueRef(
  sourceRef: string,
  repo: { owner: string; repo: string },
): boolean {
  if (!/#\d+$/.test(sourceRef)) return false
  if (/^#\d+$/.test(sourceRef) || /^\d+$/.test(sourceRef)) return true
  return sourceRef.toLowerCase().startsWith(`${repo.owner}/${repo.repo}#`.toLowerCase())
}
