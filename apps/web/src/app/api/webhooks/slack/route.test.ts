import { describe, expect, it } from 'vitest'
import { slackReviewerAllowed } from '../../../../lib/slack-auth.js'

describe('Slack reviewer authorization', () => {
  it('allows only exact configured Slack member ids', () => {
    expect(slackReviewerAllowed('U123', 'U123, U456')).toBe(true)
    expect(slackReviewerAllowed('U456', 'U123, U456')).toBe(true)
    expect(slackReviewerAllowed('U12', 'U123, U456')).toBe(false)
    expect(slackReviewerAllowed('U999', 'U123, U456')).toBe(false)
  })

  it('fails closed when the user or allowlist is absent', () => {
    expect(slackReviewerAllowed(undefined, 'U123')).toBe(false)
    expect(slackReviewerAllowed('U123', undefined)).toBe(false)
    expect(slackReviewerAllowed('U123', '')).toBe(false)
  })
})
