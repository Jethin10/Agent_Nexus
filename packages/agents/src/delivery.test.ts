import { describe, expect, it } from 'vitest'
import { scanDiff } from '@ascendant/core'
import { branchName, commitMessage, decisionComment, deliver, prBody } from './delivery.js'
import type { DeliveryInput } from './delivery.js'

const DECISION_ID = '11111111-2222-4333-8444-555555555555'

function diffFor(path: string, added: string[], removed: string[] = []) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,3 +1,3 @@',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n')
}

function input(over: Partial<DeliveryInput> = {}): DeliveryInput {
  const diff = diffFor('src/session.ts', ['  if (!token) return null'])
  return {
    ticket: {
      title: 'Fix session id crash on expired token',
      statement: 'getSessionId throws once the token expires.',
      linearIdentifier: 'ENG-142',
    },
    decision: {
      id: DECISION_ID,
      outcome: 'ACCEPT',
      confidence: 0.87,
      reasoning: 'This is a real crash with a reproduction and a clear owner in the session helper.',
      citations: [
        {
          kind: 'issue',
          ref: 'https://github.com/acme/api/issues/412',
          quote: "TypeError: cannot read 'id' of undefined",
          why: 'The same stack trace was reported here.',
        },
      ],
    },
    plan: {
      statement: 'Guard the expired-token path and cover it with a test.',
      steps: [
        { order: 1, path: 'src/session.ts', change: 'Return null when the token has expired.' },
      ],
      risks: [{ risk: 'Callers may rely on the throw.', level: 'medium' }],
      testPlan: ['pnpm test src/session.test.ts'],
    },
    debate: [
      { agent: 'planner', round: 1, summary: '1 step across 1 file' },
      { agent: 'reviewer', round: 1, summary: 'revise — 1 comment' },
    ],
    reviews: [
      {
        verdict: 'approve',
        summary: 'Correct after the revision.',
        comments: [
          { path: 'src/session.ts', severity: 'minor', comment: 'consider logging the expiry' },
        ],
      },
    ],
    qa: { verdict: 'pass', summary: 'all green', failures: [], flaky: [] },
    scan: scanDiff(diff),
    testCommands: ['pnpm test'],
    ...over,
  }
}

describe('branchName — §8.1, never main', () => {
  it('builds ascendant/<linear-id>-<slug>', () => {
    expect(branchName('Fix session id crash on expired token', 'ENG-142')).toBe(
      'ascendant/eng-142-fix-session-id-crash-on-expired-token',
    )
  })

  it('is always under the ascendant/ namespace', () => {
    for (const title of ['main', 'HEAD', '../escape', '']) {
      expect(branchName(title, 'ENG-1').startsWith('ascendant/')).toBe(true)
    }
  })

  it('strips characters that are illegal in a git ref', () => {
    expect(branchName('Fix: the thing!! (again)', 'ENG-9')).toBe('ascendant/eng-9-fix-the-thing-again')
  })

  it('survives a ticket with no Linear id yet', () => {
    expect(branchName('Some fix')).toBe('ascendant/ung-some-fix')
  })

  it('caps the slug rather than producing an unbounded ref', () => {
    const b = branchName('word '.repeat(60), 'ENG-1')
    expect(b.length).toBeLessThan(80)
    expect(b.endsWith('-')).toBe(false)
  })
})

describe('commitMessage — the audit link', () => {
  it('carries the decision id and confidence as trailers', () => {
    const msg = commitMessage(input())
    expect(msg).toContain(`Ascendant-Decision: ${DECISION_ID}`)
    expect(msg).toContain('Ascendant-Confidence: 0.87')
    expect(msg).toContain('Co-Authored-By: Ascendant <ascendant@users.noreply.github.com>')
  })

  it('puts the subject on the first line, under git conventions', () => {
    const lines = commitMessage(input()).split('\n')
    expect(lines[0]).toBe('Fix session id crash on expired token (ENG-142)')
    expect(lines[0]?.length).toBeLessThanOrEqual(72)
    expect(lines[1]).toBe('')
  })
})

describe('prBody — six fixed sections, no embellishment', () => {
  it('has every section §8.1 requires', () => {
    const body = prBody(input())
    for (const heading of ['## What changed', '## Why', '## Tests', '## Risk', '## Undo']) {
      expect(body).toContain(heading)
    }
  })

  it('reproduces the triage reasoning verbatim — it is the audit trail, not a paraphrase', () => {
    const i = input()
    expect(prBody(i)).toContain(i.decision.reasoning)
  })

  it('renders citations as links with their quotes', () => {
    const body = prBody(input())
    expect(body).toContain('https://github.com/acme/api/issues/412')
    expect(body).toContain("TypeError: cannot read 'id' of undefined")
  })

  it('lists each touched file with a reason drawn from the plan', () => {
    expect(prBody(input())).toContain('`src/session.ts` — Return null when the token has expired.')
  })

  it('collapses the debate rather than dumping it', () => {
    const body = prBody(input())
    expect(body).toContain('<details>')
    expect(body).toContain('consider logging the expiry')
  })

  it('states plainly when there was no test signal', () => {
    const body = prBody(input({ qa: undefined }))
    expect(body).toContain('No test signal was available')
    expect(body).toContain('The test suite did not produce a usable signal.')
  })

  it('reports flaky tests as flaky rather than as failures', () => {
    const body = prBody(
      input({
        qa: { verdict: 'pass', summary: 'green on retry', failures: [], flaky: ['boots slowly'] },
      }),
    )
    expect(body).toContain('Marked flaky')
    expect(body).toContain('boots slowly')
  })

  it('carries the Planner’s risks through unchanged', () => {
    expect(prBody(input())).toContain('Callers may rely on the throw.')
  })

  it('always offers the one-command undo', () => {
    expect(prBody(input())).toContain('/ascendant revert')
  })

  it('says out loud that it is never auto-merged', () => {
    expect(prBody(input())).toContain('a human approves every merge')
  })
})

describe('deliver — draft policy', () => {
  it('opens ready-for-review above the autonomy threshold', () => {
    expect(deliver(input()).isDraft).toBe(false)
  })

  it('opens as a draft below it', () => {
    const out = deliver(input({ decision: { ...input().decision, confidence: 0.62 } }))
    expect(out.isDraft).toBe(true)
    expect(out.slackSummary).toContain('draft')
  })

  it('honours a threshold dragged up in config', () => {
    expect(deliver(input(), { autonomousThreshold: 0.95 }).isDraft).toBe(true)
  })

  it('forces a draft when the deterministic scan found a blocker, at any confidence', () => {
    const diff = diffFor('src/a.ts', ['eval(userInput)'])
    const out = deliver(
      input({ scan: scanDiff(diff), decision: { ...input().decision, confidence: 0.99 } }),
    )
    expect(out.isDraft).toBe(true)
  })

  it('summarises for Slack without inventing impact', () => {
    const out = deliver(input())
    expect(out.slackSummary).toContain('ACCEPT at 0.87')
    expect(out.slackSummary).toContain('Tests: pass')
  })
})

describe('decisionComment — §5.5, a refusal that reads like a person wrote it', () => {
  const base = {
    outcome: 'REJECT',
    confidence: 0.89,
    reasoning: 'This contradicts a documented architecture decision from 2026-06-12.',
    citations: [
      {
        kind: 'doc' as const,
        ref: 'docs/adr/003-no-graphql.md',
        quote: 'we are not adding a GraphQL layer, decided 2026-06-12',
        why: 'The request asks for exactly what this decision declined.',
      },
    ],
  }

  it('states the decision, the confidence, the evidence and the undo', () => {
    const c = decisionComment(base)
    expect(c).toContain('confidence 0.89')
    expect(c).toContain('we are not adding a GraphQL layer')
    expect(c).toContain('/ascendant reopen')
  })

  it('names the duplicate target on a MERGE', () => {
    const c = decisionComment({ ...base, outcome: 'MERGE', mergeTargetId: 'acme/api#412' })
    expect(c).toContain('duplicate of acme/api#412')
  })

  it('asks the specific questions on a DEFER', () => {
    const c = decisionComment({
      ...base,
      outcome: 'DEFER',
      missingInfo: ['What are the exact steps to reproduce?'],
    })
    expect(c).toContain('What are the exact steps to reproduce?')
  })

  it('makes clear that an ESCALATE closed nothing', () => {
    const c = decisionComment({ ...base, outcome: 'ESCALATE' })
    expect(c).toContain('Nothing has been closed')
    expect(c).not.toContain('/ascendant reopen')
  })
})
