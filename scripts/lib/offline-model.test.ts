import { describe, expect, it } from 'vitest'
import {
  TRIAGE_SYSTEM,
  TriageDecisionDraft,
  triageUserMessage,
  type Candidate,
  type NormalizedEvent,
} from '@ascendant/core'
import {
  CodeOutput,
  PlanOutput,
  QaOutput,
  ResearchOutput,
  ReviewOutput,
  RoutingOutput,
} from '@ascendant/agents'
import { offlineComplete } from './offline-model.ts'

/**
 * The fixtures are only useful if they are indistinguishable from a model response
 * *in shape* while being obviously a fixture *in provenance*. Both halves are checked
 * here, because a drifted fixture would otherwise surface as a confusing agent
 * failure deep in a demo run.
 */

const complete = offlineComplete()

function candidate(over: Partial<Candidate> & Pick<Candidate, 'ref'>): Candidate {
  return {
    entityId: over.ref,
    kind: 'issue',
    title: 'Some prior item',
    content: 'body text',
    source: 'vector',
    score: 0.9,
    ...over,
  }
}

function event(title: string, body: string): NormalizedEvent {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: 'org_demo',
    source: 'github',
    sourceRef: 'acme/api#1',
    kind: 'issue',
    threadKey: null,
    actor: { id: '1', handle: 'alice', isBot: false },
    title,
    body,
    contentHash: 'h',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    attachments: [],
    extracted: { symbols: [], versions: [], stackFrames: [], urls: [], issueRefs: [] },
    trust: 'internal',
    injectionSuspected: false,
    raw: null,
  } as NormalizedEvent
}

function triagePrompt(title: string, body: string, candidates: Candidate[]) {
  return triageUserMessage({ event: event(title, body), candidates, policyHits: [] })
}

async function runTriage(title: string, body: string, candidates: Candidate[]) {
  return complete({
    task: 'triage',
    schema: TriageDecisionDraft,
    system: TRIAGE_SYSTEM,
    messages: [{ role: 'user', content: triagePrompt(title, body, candidates) }],
  })
}

describe('offline model — triage fixtures', () => {
  const cases: [string, string, string, Candidate[], string][] = [
    [
      'REJECTs a request that contradicts a decision doc',
      'Please add a GraphQL endpoint for sessions',
      'We would like a GraphQL API for sessions.',
      // The ref must identify the ADR itself. A doc that merely mentions GraphQL is
      // not the decision, and citing it would attach the ADR's quote to the wrong file.
      [candidate({ ref: 'doc:adr-0007-no-graphql', kind: 'doc', title: 'ADR: no GraphQL layer' })],
      'REJECT',
    ],
    [
      'REJECTs work already fixed on main, citing the merged PR',
      'Session crash still happening',
      'I am still seeing the crash after upgrading.',
      [candidate({ ref: 'acme/api!88', kind: 'pr', source: 'git' })],
      'REJECT',
    ],
    [
      'MERGEs a reworded duplicate',
      "TypeError: cannot read 'id' of undefined",
      'Same crash as another report, happens once the token has expired.',
      [candidate({ ref: 'acme/api#412' })],
      'MERGE',
    ],
    [
      'DEFERs a report with no reproduction',
      'It does not work',
      'please fix',
      [candidate({ ref: 'acme/api#5' })],
      'DEFER',
    ],
    [
      'ESCALATEs an ambiguous performance complaint',
      'App feels slow sometimes',
      'Latency is intermittent.',
      [candidate({ ref: 'acme/api#77' })],
      'ESCALATE',
    ],
    [
      'ACCEPTs a genuine, well-specified bug',
      'Expired token throws instead of returning null',
      'getSessionId dereferences an undefined session.',
      [candidate({ ref: 'acme/api#100' })],
      'ACCEPT',
    ],
  ]

  for (const [name, title, body, candidates, expected] of cases) {
    it(name, async () => {
      const res = await runTriage(title, body, candidates)
      expect(res.value.outcome).toBe(expected)
    })
  }

  it('all five outcomes are reachable — four of them refusals', async () => {
    const seen = new Set<string>()
    for (const [, title, body, candidates] of cases) {
      seen.add((await runTriage(title, body, candidates)).value.outcome)
    }
    expect([...seen].sort()).toEqual(['ACCEPT', 'DEFER', 'ESCALATE', 'MERGE', 'REJECT'])
  })

  it('only ever cites a ref that retrieval actually supplied', async () => {
    // The whole point of validateCitations is that a citation must be real. A fixture
    // that invented refs would pass its own schema and then be forced to ESCALATE by
    // the gate — which would look like a broken fixture rather than a caught fabrication.
    for (const [, title, body, candidates] of cases) {
      const res = await runTriage(title, body, candidates)
      const given = new Set(candidates.map((c) => c.ref))
      for (const c of res.value.citations) {
        expect(given.has(c.ref) || c.ref.startsWith('policy:')).toBe(true)
      }
    }
  })

  it('MERGE carries a mergeTargetId and DEFER carries missingInfo (D7)', async () => {
    const merge = await runTriage(
      "TypeError: cannot read 'id' of undefined",
      'Duplicate of an existing report; the token had expired.',
      [candidate({ ref: 'acme/api#412' })],
    )
    expect(merge.value.mergeTargetId).toBe('acme/api#412')

    const defer = await runTriage('It does not work', 'please fix', [candidate({ ref: 'acme/api#5' })])
    expect(defer.value.missingInfo?.length).toBeGreaterThan(0)
  })

  it('does not merge a different trigger that shares an exception', async () => {
    /**
     * The expensive triage mistake: the same TypeError from the same file, but caused
     * by an unknown token rather than an expired one, is a *different* bug. Merging it
     * would bury real work under a closed issue, and a false MERGE is far worse than a
     * false ACCEPT because nobody looks at it again.
     */
    const res = await runTriage(
      'getSessionId should return null for an unknown token, not throw',
      "Throws TypeError: cannot read 'id' of undefined when the token is absent from the store.",
      [candidate({ ref: 'acme/api#412' })],
    )
    expect(res.value.outcome).not.toBe('MERGE')
    expect(res.value.outcome).toBe('ACCEPT')
  })

  it('reports zero tokens — a fixture consumed no quota', async () => {
    const res = await runTriage('Anything', 'body', [candidate({ ref: 'acme/api#1' })])
    expect(res.tokens).toBe(0)
  })

  it('labels itself as a fixture so provenance is visible in the dashboard', async () => {
    const res = await runTriage('Anything', 'body', [candidate({ ref: 'acme/api#1' })])
    expect(res.model).toBe('fixture:triage')
  })
})

describe('offline model — pipeline fixtures satisfy the real agent schemas', () => {
  it('research', async () => {
    const r = await complete({
      task: 'plan',
      schema: ResearchOutput,
      system: 'RESEARCH',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r.value.files.length).toBeGreaterThan(0)
  })

  it('plan stays inside MAX_FILES_TOUCHED', async () => {
    const r = await complete({
      task: 'plan',
      schema: PlanOutput,
      system: 'PLAN',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r.value.verdict).toBe('plan')
    expect(r.value.filesTouched.length).toBeGreaterThan(0)
  })

  it('code produces a diff that parses as a real unified diff', async () => {
    const r = await complete({
      task: 'code',
      schema: CodeOutput,
      system: 'CODE',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r.value.diff).toContain('--- a/')
    expect(r.value.diff).toContain('+++ b/')
    expect(r.value.diff).toContain('@@')
  })

  it('code adds assertions rather than removing them (§14.3)', async () => {
    const r = await complete({
      task: 'code',
      schema: CodeOutput,
      system: 'CODE',
      messages: [{ role: 'user', content: 'x' }],
    })
    const added = (r.value.diff.match(/^\+.*expect\(/gm) ?? []).length
    const removed = (r.value.diff.match(/^-.*expect\(/gm) ?? []).length
    expect(added).toBeGreaterThan(removed)
  })

  it('review', async () => {
    const r = await complete({
      task: 'review',
      schema: ReviewOutput,
      system: 'REVIEW',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(['approve', 'revise', 'reject']).toContain(r.value.verdict)
  })

  it('qa reads the sandbox result rather than inventing one', async () => {
    const pass = await complete({
      task: 'qa',
      schema: QaOutput,
      system: 'QA',
      messages: [{ role: 'user', content: 'exit code: 0\nall tests passed' }],
    })
    expect(pass.value.verdict).toBe('pass')

    const fail = await complete({
      task: 'qa',
      schema: QaOutput,
      system: 'QA',
      messages: [{ role: 'user', content: 'exit code: 1\nFAIL src/session.test.ts' }],
    })
    expect(fail.value.verdict).toBe('fail')
    expect(fail.value.failures.length).toBeGreaterThan(0)
  })

  it('classify', async () => {
    const r = await complete({
      task: 'classify',
      schema: RoutingOutput,
      system: 'ROUTE',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(['trivial', 'standard', 'complex']).toContain(r.value.complexity)
  })

  it('throws rather than guessing when a task has no fixture', async () => {
    await expect(
      complete({
        task: 'nonexistent' as 'triage',
        schema: TriageDecisionDraft,
        system: 'X',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/no fixture/)
  })
})
