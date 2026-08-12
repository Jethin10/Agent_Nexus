'use server'

import { revalidatePath } from 'next/cache'
import { TriageOutcome } from '@ascendant/core'
import { applyHumanReview, db } from '@ascendant/db'
import { inngest } from '@ascendant/workflows'
import { ensureDb } from '@/lib/local-db'
import { currentOrgId } from '@/lib/org'

export interface ReviewActionState {
  ok: boolean
  message: string
}

/** Persist first, then ask Inngest to resume any parked run. */
export async function resolveReview(
  _previous: ReviewActionState | null,
  form: FormData,
): Promise<ReviewActionState> {
  const decisionId = String(form.get('decisionId') ?? '')
  const eventId = String(form.get('eventId') ?? '')
  const parsedOutcome = TriageOutcome.safeParse(form.get('outcome'))
  const reason = String(form.get('reason') ?? '').trim().slice(0, 1_000)
  if (!decisionId || !eventId || !parsedOutcome.success) {
    return { ok: false, message: 'The review request is incomplete.' }
  }

  const orgId = currentOrgId()
  const actor = 'dashboard-reviewer'

  try {
    await ensureDb()
    const result = await applyHumanReview(db(), {
      orgId,
      eventId,
      decisionId,
      outcome: parsedOutcome.data,
      actor,
      ...(reason ? { reason } : {}),
      surface: 'dashboard',
    })

    let workflowNotified = false
    try {
      // Stable id makes a repeated submit a safe repair for "DB committed, Inngest
      // unavailable" without creating duplicate workflow events.
      await inngest.send({
        id: `ascendant:human:${eventId}:${result.outcome}`,
        name: 'human/resolved',
        data: {
          orgId,
          eventId,
          decisionId,
          outcome: result.outcome,
          actor,
          ...(reason ? { reason } : {}),
        },
      })
      workflowNotified = true
    } catch {
      // The DB row is authoritative. Repeating the review safely retries dispatch.
    }

    revalidatePath(`/events/${eventId}`)
    revalidatePath('/')
    revalidatePath('/metrics')

    if (result.status === 'already_reviewed') {
      return { ok: true, message: `This event was already reviewed as ${result.outcome}.` }
    }
    return {
      ok: true,
      message: workflowNotified
        ? `Review persisted and the workflow was notified: ${result.outcome}.`
        : `Review persisted: ${result.outcome}. Workflow continuation is pending because Inngest is not connected.`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'The review could not be recorded.' }
  }
}
