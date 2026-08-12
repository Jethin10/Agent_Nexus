'use client'

import { useActionState } from 'react'
import type { TriageOutcome } from '@ascendant/core'
import {
  resolveReview,
  type ReviewActionState,
} from '@/app/events/[id]/actions'

export function EventReviewActions({
  eventId,
  decisionId,
  outcome,
}: {
  eventId: string
  decisionId: string
  outcome: TriageOutcome
}) {
  const [state, action, pending] = useActionState<ReviewActionState | null, FormData>(
    resolveReview,
    null,
  )

  if (state?.ok) {
    return (
      <div className="event-action-result" role="status">
        <span>✓</span>
        <div>
          <strong>Human review persisted</strong>
          <p>{state.message}</p>
        </div>
      </div>
    )
  }

  return (
    <form action={action} className="event-review-form" aria-label="Review this decision">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="decisionId" value={decisionId} />
      <label>
        <span>Reviewer note</span>
        <input
          name="reason"
          placeholder="Why are you confirming or changing this decision?"
          maxLength={1_000}
        />
      </label>
      <div className="event-review-actions">
        <button type="submit" name="outcome" value={outcome} className="primary" disabled={pending}>
          Confirm {label(outcome)}
        </button>
        {outcome !== 'ACCEPT' && (
          <button type="submit" name="outcome" value="ACCEPT" disabled={pending}>
            Override to accept
          </button>
        )}
        {outcome !== 'REJECT' && (
          <button type="submit" name="outcome" value="REJECT" disabled={pending}>
            Override to reject
          </button>
        )}
        <small>A confirmation writes an outcome; an override writes an immutable overturn.</small>
      </div>
      {state && !state.ok && <p className="action-error" role="alert">{state.message}</p>}
    </form>
  )
}

function label(outcome: TriageOutcome): string {
  return outcome.charAt(0) + outcome.slice(1).toLowerCase()
}
