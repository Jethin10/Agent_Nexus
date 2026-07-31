import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { decide, normalize, type Candidate, type NormalizedEvent, type RawEvent } from '@ascendant/core'
import { triage } from './triage.js'
import type { AgentContext, AgentTrace, CompleteFn } from './types.js'

const FIXED_ID = '00000000-0000-4000-8000-000000000001'

function ev(over: Partial<RawEvent> = {}, opts: { injectionSuspected?: boolean } = {}): NormalizedEvent {
  const raw: RawEvent = {
    orgId: 'org_demo',
    source: 'github',
    sourceRef: 'acme/api#1041',
    kind: 'issue',
    threadKey: 'acme/api#1041',
    actor: { id: '1', handle: 'octocat', isBot: false },
    title: 'Please add a GraphQL endpoint for sessions',
    body: 'It would be nicer to query sessions over GraphQL rather than the REST endpoint.',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    attachments: [],
    raw: {},
    ...over,
  }
  return normalize(raw, { id: FIXED_ID, internalActors: ['octocat'], ...opts })
}

const adr = (over: Partial<Candidate> = {}): Candidate => ({
  entityId: 'doc-adr-003',
  kind: 'doc',
  ref: 'docs/adr/003-no-graphql.md',
  title: 'ADR 003: no GraphQL layer',
  content: 'we are not adding a GraphQL layer, decided 2026-06-12',
  source: 'vector',
  score: 0.9,
  ...over,
})

/** A canned model response. No network, no provider, no router internals. */
function ctxWith(value: unknown, traces: AgentTrace[] = []): AgentContext {
  const complete = vi.fn(async (opts: { schema: z.ZodType<unknown> }) => ({
    value: opts.schema.parse(value),
    model: 'groq/llama-3.3-70b',
    tokens: 900,
    latencyMs: 1_200,
    attempts: [],
  })) as unknown as CompleteFn
  return {
    orgId: 'org_demo',
    complete,
    trace: (t) => {
      traces.push(t)
    },
  }
}

const draft = (over: Record<string, unknown> = {}) => ({
  outcome: 'REJECT',
  confidence: 0.9,
  reasoning:
    'This contradicts a documented architecture decision: ADR 003 records that we are not adding a GraphQL layer, decided on 2026-06-12.',
  citations: [
    {
      kind: 'doc',
      ref: 'docs/adr/003-no-graphql.md',
      quote: 'we are not adding a GraphQL layer, decided 2026-06-12',
      why: 'The request asks for exactly what this decision declined.',
    },
  ],
  ...over,
})

describe('triage — the deterministic stage decides without a model', () => {
  it('short-circuits the LLM entirely on a decisive rule', async () => {
    const event = ev({ actor: { id: '9', handle: 'dependabot[bot]', isBot: true } })
    const ctx = ctxWith(draft())
    const res = await triage(ctx, { event, candidates: [], policy: decide(event) })

    expect(res.decidedByPolicy).toBe(true)
    expect(res.outcome).toBe('REJECT')
    expect(res.cost.tokens).toBe(0)
    expect(res.cost.model).toBe('policy')
    expect(ctx.complete).not.toHaveBeenCalled()
  })

  it('names the rule as its citation, so a mechanical refusal still carries evidence', async () => {
    const event = ev({ body: '' })
    const res = await triage(ctxWith(draft()), { event, candidates: [], policy: decide(event) })
    expect(res.outcome).toBe('DEFER')
    expect(res.citations[0]?.ref).toBe('policy:empty_body')
    expect(res.missingInfo?.length).toBeGreaterThan(0)
  })

  it('names the merge target when the content hash matched', async () => {
    const event = ev()
    const policy = decide(event, { openByContentHash: { [event.contentHash]: 'acme/api#412' } })
    const res = await triage(ctxWith(draft()), { event, candidates: [], policy })
    expect(res.outcome).toBe('MERGE')
    expect(res.mergeTargetId).toBe('acme/api#412')
  })

  it('applies the injection ceiling to a mechanical decision too', async () => {
    const event = ev({ actor: { id: '9', handle: 'bot[bot]', isBot: true } }, { injectionSuspected: true })
    const res = await triage(ctxWith(draft()), { event, candidates: [], policy: decide(event) })
    expect(res.outcome).toBe('ESCALATE')
    expect(res.autonomous).toBe(false)
  })

  it('records every rule that fired, not only the decisive one', async () => {
    const event = ev({ actor: { id: '9', handle: 'bot[bot]', isBot: true }, body: '' })
    const res = await triage(ctxWith(draft()), { event, candidates: [], policy: decide(event) })
    expect(res.policyHits).toEqual(['bot_author', 'empty_body'])
  })
})

describe('triage — the model stage', () => {
  it('rejects a request that contradicts a documented decision, citing the doc', async () => {
    const event = ev()
    const traces: AgentTrace[] = []
    const res = await triage(ctxWith(draft(), traces), {
      event,
      candidates: [adr()],
      policy: decide(event),
    })

    expect(res.outcome).toBe('REJECT')
    expect(res.decidedByPolicy).toBe(false)
    expect(res.citations[0]?.ref).toBe('docs/adr/003-no-graphql.md')
    expect(res.autonomous).toBe(true)
    expect(res.cost.model).toBe('groq/llama-3.3-70b')
    expect(traces[0]?.phase).toBe('decided')
  })

  it('recomputes confidence rather than trusting the model — self-report is 50% at most', async () => {
    const event = ev()
    // The model claims certainty, but there is no comparable neighbour at all.
    const res = await triage(ctxWith(draft({ confidence: 1, outcome: 'ACCEPT' })), {
      event,
      candidates: [adr({ source: 'lexical', score: 0.99 })],
      policy: decide(event),
    })
    expect(res.components.modelSelfReport).toBe(1)
    expect(res.components.evidenceStrength).toBe(0)
    expect(res.confidence).toBeLessThan(1)
    expect(res.autonomous).toBe(false)
  })

  it('stores all three confidence components so calibration is auditable', async () => {
    const event = ev()
    const res = await triage(ctxWith(draft()), { event, candidates: [adr()], policy: decide(event) })
    expect(Object.keys(res.components).sort()).toEqual([
      'evidenceStrength',
      'modelSelfReport',
      'policyAgreement',
    ])
  })

  it('cites a prior decision, so a re-filed issue is refused consistently', async () => {
    const event = ev()
    const prior = adr({
      entityId: 'decision:abc',
      ref: 'decision:abc',
      source: 'decision',
      priorOutcome: 'REJECT',
      score: 0.93,
      content: 'We previously decided REJECT at confidence 0.89.',
    })
    const res = await triage(
      ctxWith(
        draft({
          citations: [
            { kind: 'ticket', ref: 'decision:abc', quote: 'We previously decided REJECT', why: 'same request' },
          ],
        }),
      ),
      { event, candidates: [prior], policy: decide(event) },
    )
    expect(res.outcome).toBe('REJECT')
    expect(res.confidence).toBeGreaterThanOrEqual(0.8)
  })
})

describe('triage — citations are verified, not trusted', () => {
  it('escalates when the model cites a ref it was never given', async () => {
    const event = ev()
    const traces: AgentTrace[] = []
    const res = await triage(
      ctxWith(
        draft({
          outcome: 'MERGE',
          mergeTargetId: 'acme/api#412',
          citations: [
            { kind: 'issue', ref: 'acme/api#412', quote: 'same failure', why: 'looks identical' },
          ],
        }),
        traces,
      ),
      { event, candidates: [adr()], policy: decide(event) },
    )

    expect(res.outcome).toBe('ESCALATE')
    expect(res.bandApplied).toContain('fabricated_citation')
    expect(res.autonomous).toBe(false)
    expect(traces[0]?.detail?.fabricatedRefs).toEqual(['acme/api#412'])
  })

  it('accepts a citation that resolves by entity id rather than ref', async () => {
    const event = ev()
    const res = await triage(
      ctxWith(
        draft({
          citations: [{ kind: 'doc', ref: 'doc-adr-003', quote: 'no GraphQL', why: 'declined' }],
        }),
      ),
      { event, candidates: [adr()], policy: decide(event) },
    )
    expect(res.outcome).toBe('REJECT')
    expect(res.bandApplied).not.toContain('fabricated_citation')
  })

  it('refuses to refuse with no evidence at all', async () => {
    const event = ev()
    const res = await triage(ctxWith(draft({ citations: [{ kind: 'doc', ref: 'policy:none', quote: 'q', why: 'w' }] })), {
      event,
      candidates: [],
      policy: decide(event),
    })
    expect(res.outcome).toBe('ESCALATE')
    expect(res.bandApplied).toContain('fabricated_citation')
  })

  it('lets an ACCEPT through with no neighbours — nothing to compare against is not a refusal', async () => {
    const event = ev({ title: 'Session id crash', body: 'Throws in `auth.getSessionId(token)` after expiry on v2.3.1.' })
    const res = await triage(
      ctxWith(
        draft({
          outcome: 'ACCEPT',
          confidence: 0.9,
          citations: [{ kind: 'doc', ref: 'doc-adr-003', quote: 'unrelated', why: 'context' }],
        }),
      ),
      { event, candidates: [adr()], policy: decide(event) },
    )
    expect(res.outcome).toBe('ACCEPT')
  })
})

describe('triage — bands come from config', () => {
  it('holds the decision but revokes autonomy when the threshold is dragged up (§16 beat 4)', async () => {
    const event = ev()
    const input = { event, candidates: [adr()], policy: decide(event) }

    const before = await triage(ctxWith(draft()), input)
    const after = await triage(ctxWith(draft()), {
      ...input,
      bands: { autonomous: 0.95, flagged: 0.55, injectionCeiling: 0.5 },
    })

    expect(before.autonomous).toBe(true)
    expect(after.outcome).toBe(before.outcome)
    expect(after.confidence).toBeCloseTo(before.confidence, 12)
    expect(after.autonomous).toBe(false)
    expect(after.needsReview).toBe(true)
  })

  it('escalates a suspected injection whatever the model concluded', async () => {
    const event = ev({}, { injectionSuspected: true })
    const res = await triage(ctxWith(draft({ outcome: 'ACCEPT', confidence: 1 })), {
      event,
      candidates: [adr()],
      policy: decide(event),
    })
    expect(res.outcome).toBe('ESCALATE')
    expect(res.confidence).toBeLessThanOrEqual(0.5)
    expect(res.bandApplied).toContain('injection_ceiling')
  })

  it('denies an anonymous filer an autonomous close', async () => {
    const raw = { actor: { id: '5', handle: 'stranger', isBot: false } }
    const event = normalize(
      {
        orgId: 'org_demo',
        source: 'github',
        sourceRef: 'acme/api#1042',
        kind: 'issue',
        threadKey: 'acme/api#1042',
        title: 'Please add a GraphQL endpoint for sessions',
        body: 'It would be nicer to query sessions over GraphQL rather than the REST endpoint.',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        attachments: [],
        raw: {},
        ...raw,
      },
      { id: FIXED_ID },
    )
    const res = await triage(ctxWith(draft()), { event, candidates: [adr()], policy: decide(event) })
    expect(event.trust).toBe('anonymous')
    expect(res.outcome).toBe('REJECT')
    expect(res.autonomous).toBe(false)
    expect(res.bandApplied).toContain('anonymous_no_autonomous_close')
  })
})

describe('triage — the prompt it sends', () => {
  it('puts the system rules in the system role and the event in a delimited user message', async () => {
    const event = ev()
    const ctx = ctxWith(draft())
    await triage(ctx, { event, candidates: [adr()], policy: decide(event) })

    const call = vi.mocked(ctx.complete).mock.calls[0]?.[0] as unknown as {
      task: string
      system: string
      messages: { role: string; content: string }[]
    }
    expect(call.task).toBe('triage')
    expect(call.system).not.toContain('GraphQL')
    expect(call.messages[0]?.role).toBe('user')
    expect(call.messages[0]?.content).toContain('<untrusted')
    expect(call.messages[0]?.content).toContain('docs/adr/003-no-graphql.md')
  })

  it('passes non-decisive rules as advisory context', async () => {
    // A thin body that still has a symbol: empty_body does not fire, so nothing is
    // decisive, but a template hint would still be worth telling the model about.
    const event = ev({ title: 'Bug', body: 'Fails in `auth.getSessionId(token)`' })
    const ctx = ctxWith(draft())
    await triage(ctx, { event, candidates: [adr()], policy: decide(event) })
    const call = vi.mocked(ctx.complete).mock.calls[0]?.[0] as unknown as {
      messages: { content: string }[]
    }
    expect(call.messages[0]?.content).toContain('## THE EVENT UNDER TRIAGE')
  })
})
