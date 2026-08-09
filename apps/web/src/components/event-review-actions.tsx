'use client'

import { useState } from 'react'

export function EventReviewActions() {
  const [decision, setDecision] = useState<'approve' | 'clarify' | 'reject' | null>(null)

  if (decision) {
    return (
      <div className="event-action-result" role="status">
        <span>✓</span>
        <div>
          <strong>{decision === 'approve' ? 'Approved and dispatched' : decision === 'clarify' ? 'More context requested' : 'Recommendation rejected'}</strong>
          <p>{decision === 'approve' ? 'The owner task, source updates, and audit entry are ready.' : 'The review was recorded in the audit trail.'}</p>
        </div>
        <button type="button" onClick={() => setDecision(null)}>Undo demo action</button>
      </div>
    )
  }

  return (
    <div className="event-review-actions" aria-label="Review actions">
      <button type="button" className="primary" onClick={() => setDecision('approve')}>Approve & dispatch</button>
      <button type="button" onClick={() => setDecision('clarify')}>Ask for context</button>
      <button type="button" onClick={() => setDecision('reject')}>Reject</button>
      <small>Demo action · no external messages are sent</small>
    </div>
  )
}
