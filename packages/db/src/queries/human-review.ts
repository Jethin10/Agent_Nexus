import { and, eq } from 'drizzle-orm'
import type { TriageOutcome } from '@ascendant/core'
import type { Db } from '../client'
import { tickets } from '../schema/tickets'
import { decisionForEvent, getDecision, insertDecision, openTicketForAccept } from './decisions'
import { getEvent } from './events'
import { overturnForDecision, recordOutcome, recordOverturn } from './metrics'

export interface HumanReviewResult {
  status: 'confirmed' | 'overturned' | 'already_reviewed'
  decisionId: string
  outcome: TriageOutcome
  ticketId?: string
}

/**
 * Applies a human judgement once, without mutating the original decision.
 *
 * Dashboard and Slack both call this function, while Inngest only receives the ids
 * needed to resume a parked run. Keeping the write here prevents the two review
 * surfaces from drifting and means an Inngest outage cannot lose the audit record.
 */
export async function applyHumanReview(
  db: Db,
  input: {
    orgId: string
    eventId: string
    decisionId: string
    outcome: TriageOutcome
    actor: string
    reason?: string
    surface: 'dashboard' | 'slack'
  },
): Promise<HumanReviewResult> {
  const [original, event, latest] = await Promise.all([
    getDecision(db, input.orgId, input.decisionId),
    getEvent(db, input.orgId, input.eventId),
    decisionForEvent(db, input.orgId, input.eventId),
  ])
  if (!original || !event || original.eventId !== event.id) {
    throw new Error('The reviewed decision does not match this event.')
  }

  if (latest?.modelUsed.startsWith('human:')) {
    return {
      status: 'already_reviewed',
      decisionId: latest.id,
      outcome: latest.outcome,
      ...(await ticketIdForEvent(db, input.orgId, event.id)),
    }
  }

  if (input.outcome === original.outcome) {
    await recordOutcome(db, {
      orgId: input.orgId,
      decisionId: original.id,
      kind: 'human_confirmed',
      correct: true,
      note: input.reason || `Confirmed by ${input.actor} from ${input.surface}.`,
      meta: { actor: input.actor, surface: input.surface },
    })
    return { status: 'confirmed', decisionId: original.id, outcome: original.outcome }
  }

  const priorOverturn = await overturnForDecision(db, input.orgId, original.id)
  if (!priorOverturn) {
    await recordOverturn(db, {
      orgId: input.orgId,
      decisionId: original.id,
      fromOutcome: original.outcome,
      toOutcome: input.outcome,
      actor: input.actor,
      reason: input.reason || `Overridden from ${input.surface}.`,
      meta: { surface: input.surface },
    })
  }

  const corrected = await insertDecision(db, {
    orgId: input.orgId,
    eventId: event.id,
    outcome: input.outcome,
    confidence: 1,
    reasoning: `@${input.actor} reviewed Ascendant's ${original.outcome} and changed it to ${input.outcome}.${
      input.reason ? ` They noted: ${input.reason}` : ''
    }`,
    citations: [
      {
        kind: 'ticket',
        ref: `decision:${original.id}`,
        quote: original.reasoning.slice(0, 400),
        why: `The human review supersedes this ${original.outcome} without editing it.`,
      },
    ],
    policyHits: [],
    autonomous: false,
    needsReview: false,
    modelUsed: `human:${input.actor}`,
  })

  let ticketId: string | undefined
  if (input.outcome === 'ACCEPT') {
    const ticket = await openTicketForAccept(db, {
      orgId: input.orgId,
      decision: corrected,
      title: event.title || event.sourceRef,
      statement: corrected.reasoning,
    })
    ticketId = ticket.id
  } else if (original.outcome === 'ACCEPT') {
    await db
      .update(tickets)
      .set({ status: 'blocked', updatedAt: new Date() })
      .where(and(eq(tickets.orgId, input.orgId), eq(tickets.eventId, event.id)))
  }

  await recordOutcome(db, {
    orgId: input.orgId,
    decisionId: corrected.id,
    ...(ticketId ? { ticketId } : {}),
    kind: 'human_overridden',
    correct: true,
    note: `${original.outcome} → ${input.outcome} by ${input.actor}.`,
    meta: { originalDecisionId: original.id, actor: input.actor, surface: input.surface },
  })

  return {
    status: 'overturned',
    decisionId: corrected.id,
    outcome: corrected.outcome,
    ...(ticketId ? { ticketId } : {}),
  }
}

async function ticketIdForEvent(
  db: Db,
  orgId: string,
  eventId: string,
): Promise<{ ticketId?: string }> {
  const rows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.eventId, eventId)))
    .limit(1)
  return rows[0]?.id ? { ticketId: rows[0].id } : {}
}
