import { describe, expect, it } from 'vitest'
import {
  githubDecisionComment,
  isConfiguredIssueRef,
  slackDecisionSummary,
} from './triage.js'

const decision = {
  decisionId: 'dec_1',
  title: 'Sessions are broken',
  outcome: 'DEFER' as const,
  confidence: 0.72,
  reasoning: 'There is no reproduction yet.',
  citations: [{ ref: 'acme/api#12', quote: 'Related report' }],
  mergeTargetId: null,
  missingInfo: ['What are the reproduction steps?'],
  autonomous: false,
}

describe('triage source responses', () => {
  it('renders auditable GitHub comments with evidence and questions', () => {
    const text = githubDecisionComment(decision)
    expect(text).toContain('Ascendant decision: DEFER')
    expect(text).toContain('acme/api#12')
    expect(text).toContain('What are the reproduction steps?')
    expect(text).toContain('dec_1')
  })

  it('renders an actionable Slack summary', () => {
    expect(slackDecisionSummary(decision)).toContain('*DEFER* · 72%')
  })

  it('will not mutate a different configured repository', () => {
    expect(isConfiguredIssueRef('acme/api#12', { owner: 'acme', repo: 'api' })).toBe(true)
    expect(isConfiguredIssueRef('other/api#12', { owner: 'acme', repo: 'api' })).toBe(false)
    expect(isConfiguredIssueRef('doc:adr-1', { owner: 'acme', repo: 'api' })).toBe(false)
  })
})
