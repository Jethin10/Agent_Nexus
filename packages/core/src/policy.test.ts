import { describe, expect, it } from 'vitest'
import { normalize } from './normalize.js'
import type { NormalizedEvent, RawEvent } from './event.js'
import { decide, policyAgreement, runPolicy, type PolicyContext } from './policy.js'

const FIXED_ID = '00000000-0000-4000-8000-000000000001'

function ev(over: Partial<RawEvent> = {}): NormalizedEvent {
  const raw: RawEvent = {
    orgId: 'org_demo',
    source: 'github',
    sourceRef: 'acme/api#1041',
    kind: 'issue',
    threadKey: 'acme/api#1041',
    actor: { id: '1', handle: 'octocat', isBot: false },
    title: 'Session id crash on expired token',
    body: 'Calling `auth.getSessionId(token)` throws once the token expires. Reproduced on v2.3.1.',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    attachments: [],
    raw: {},
    ...over,
  }
  return normalize(raw, { id: FIXED_ID })
}

const ruleIds = (e: NormalizedEvent, ctx?: PolicyContext) => runPolicy(e, ctx).map((h) => h.rule)

describe('runPolicy — a well-formed report fires nothing', () => {
  it('leaves a real bug report alone', () => {
    expect(runPolicy(ev())).toEqual([])
  })
})

describe('bot_author → REJECT', () => {
  it('fires on the provider bot flag', () => {
    const hits = runPolicy(ev({ actor: { id: '2', handle: 'dependabot[bot]', isBot: true } }))
    expect(hits[0]?.rule).toBe('bot_author')
    expect(hits[0]?.outcome).toBe('REJECT')
    expect(hits[0]?.decisive).toBe(true)
  })

  it('fires on a config-supplied handle the provider did not flag', () => {
    const e = ev({ actor: { id: '3', handle: 'ci-runner', isBot: false } })
    expect(ruleIds(e, { botHandles: ['CI-Runner'] })).toContain('bot_author')
  })

  it('does not fire for a human', () => {
    expect(ruleIds(ev(), { botHandles: ['someone-else'] })).not.toContain('bot_author')
  })
})

describe('spam_signature → REJECT', () => {
  it('fires on a promotional phrase', () => {
    const hits = runPolicy(ev({ title: 'Cheap backlinks for sale', body: 'Contact us for SEO services and guest post placement.' }))
    expect(hits[0]?.rule).toBe('spam_signature')
    expect(hits[0]?.outcome).toBe('REJECT')
  })

  it('fires on a link-only body with no report in it', () => {
    const e = ev({ title: 'look', body: 'https://example.com/a https://example.com/b' })
    expect(ruleIds(e)).toContain('spam_signature')
  })

  it('spares a link-heavy body that still carries a stack trace', () => {
    const e = ev({
      title: 'crash',
      body: 'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  at getSessionId (session.ts:88:12)',
    })
    expect(ruleIds(e)).not.toContain('spam_signature')
  })
})

describe('already_closed_ref → ESCALATE, never a silent MERGE', () => {
  it('escalates a reference to a recently closed issue', () => {
    const e = ev({ body: 'Same thing as #412 which you closed last week.' })
    const hits = runPolicy(e, { recentlyClosedRefs: ['#412'] })
    expect(hits[0]?.rule).toBe('already_closed_ref')
    expect(hits[0]?.outcome).toBe('ESCALATE')
    expect(hits[0]?.targetRef).toBe('#412')
  })

  it('ignores a reference to something still open', () => {
    const e = ev({ body: 'Related to #999.' })
    expect(ruleIds(e, { recentlyClosedRefs: ['#412'] })).not.toContain('already_closed_ref')
  })

  it('outranks exact_dupe — a regression must not be buried as a duplicate', () => {
    const e = ev({ body: 'This is the same failure that #412 described, and it is back again.' })
    const v = decide(e, {
      recentlyClosedRefs: ['#412'],
      openByContentHash: { [e.contentHash]: 'acme/api#500' },
    })
    expect(v.decided?.rule).toBe('already_closed_ref')
    expect(v.ruleIds).toEqual(['already_closed_ref', 'exact_dupe'])
  })
})

describe('exact_dupe → MERGE', () => {
  it('fires when the content hash matches an open item, and names the target', () => {
    const e = ev()
    const hits = runPolicy(e, { openByContentHash: { [e.contentHash]: 'acme/api#412' } })
    expect(hits[0]?.rule).toBe('exact_dupe')
    expect(hits[0]?.outcome).toBe('MERGE')
    expect(hits[0]?.targetRef).toBe('acme/api#412')
  })

  it('does not fire on a different hash', () => {
    expect(ruleIds(ev(), { openByContentHash: { deadbeef: 'acme/api#412' } })).toEqual([])
  })
})

describe('template_unfilled → DEFER', () => {
  it('fires on an unfilled template and supplies the questions to ask', () => {
    const e = ev({
      title: 'Bug',
      body: '<!-- Describe the bug below -->\n### Steps to reproduce\n### Expected behaviour\nTODO',
    })
    const hits = runPolicy(e)
    expect(hits[0]?.rule).toBe('template_unfilled')
    expect(hits[0]?.outcome).toBe('DEFER')
    expect(hits[0]?.missingInfo?.length).toBeGreaterThan(0)
  })

  it('spares a filled-in template that carries a real repro', () => {
    const e = ev({
      title: 'Bug',
      body: '### Steps to reproduce\nCall `auth.getSessionId(token)` after expiry.\n### Expected\nNo throw.',
    })
    expect(ruleIds(e)).not.toContain('template_unfilled')
  })
})

describe('empty_body → DEFER', () => {
  it('fires on an empty body', () => {
    const hits = runPolicy(ev({ body: '' }))
    expect(hits.at(-1)?.rule).toBe('empty_body')
    expect(hits.at(-1)?.outcome).toBe('DEFER')
  })

  it('fires on a body under the minimum with nothing extractable', () => {
    expect(ruleIds(ev({ title: 'broken', body: 'it broke' }))).toContain('empty_body')
  })

  it('spares a short body that carries a stack frame', () => {
    const e = ev({ title: 'crash', body: '  at boot (a.ts:1:1)' })
    expect(ruleIds(e)).not.toContain('empty_body')
  })

  it('spares a short body that carries an attachment', () => {
    const e = ev({
      title: 'crash',
      body: 'see log',
      attachments: [{ name: 'log.txt', url: 'https://x/y', mime: 'text/plain' }],
    })
    expect(ruleIds(e)).not.toContain('empty_body')
  })
})

describe('decide', () => {
  it('returns no decision when nothing fires, so the LLM runs', () => {
    const v = decide(ev())
    expect(v.decided).toBeUndefined()
    expect(v.ruleIds).toEqual([])
  })

  it('records every hit even though only one decides', () => {
    const e = ev({ actor: { id: '2', handle: 'bot[bot]', isBot: true }, body: '' })
    const v = decide(e)
    expect(v.decided?.rule).toBe('bot_author')
    expect(v.ruleIds).toEqual(['bot_author', 'empty_body'])
  })

  it('orders REJECT ahead of DEFER', () => {
    const e = ev({ title: 'buy cheap viagra', body: '' })
    expect(decide(e).decided?.outcome).toBe('REJECT')
  })
})

describe('policyAgreement', () => {
  it('is mildly positive when no rule fired', () => {
    expect(policyAgreement([], 'ACCEPT')).toBe(0.6)
  })

  it('is full when a rule predicted the same outcome', () => {
    const hits = runPolicy(ev({ body: '' }))
    expect(policyAgreement(hits, 'DEFER')).toBe(1)
  })

  it('is low but non-zero when rules fired and disagreed', () => {
    const hits = runPolicy(ev({ body: '' }))
    expect(policyAgreement(hits, 'ACCEPT')).toBe(0.2)
  })
})
