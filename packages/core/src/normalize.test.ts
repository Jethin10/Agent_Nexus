import { describe, expect, it } from 'vitest'
import type { RawEvent } from './event.js'
import { contentHash, deriveTrust, normalize, stripQuoted, unitKey } from './normalize.js'

const FIXED_ID = '00000000-0000-4000-8000-000000000001'

function raw(over: Partial<RawEvent> = {}): RawEvent {
  return {
    orgId: 'org_demo',
    source: 'github',
    sourceRef: 'issue:1041',
    kind: 'issue',
    threadKey: null,
    actor: { id: '1', handle: 'octocat', isBot: false },
    title: '  Crash in getSessionId  ',
    body: 'Throws on expired token in src/auth/session.ts',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    attachments: [],
    raw: { provider: 'payload' },
    ...over,
  }
}

describe('stripQuoted', () => {
  it('drops quoted lines', () => {
    expect(stripQuoted('mine\n> theirs\nalso mine')).toBe('mine\nalso mine')
  })

  it('truncates at an "On ... wrote:" header', () => {
    const body = 'mine\nOn Tue, 1 Jul 2026 at 09:00, Alex Doe wrote:\ntheirs'
    expect(stripQuoted(body)).toBe('mine')
  })

  it('truncates at an Original Message divider', () => {
    expect(stripQuoted('mine\n----- Original Message -----\ntheirs')).toBe('mine')
  })

  it('truncates at a bare signature delimiter', () => {
    expect(stripQuoted('mine\n--\nAlex, VP of Something')).toBe('mine')
  })

  it('normalizes CRLF', () => {
    expect(stripQuoted('a\r\nb')).toBe('a\nb')
  })
})

describe('contentHash', () => {
  it('is 64 hex chars', () => {
    expect(contentHash('t', 'b')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across cosmetic whitespace edits', () => {
    const a = contentHash('Title', 'one   two\n\n\n\nthree')
    const b = contentHash('Title', 'one\ttwo\n\nthree')
    expect(a).toBe(b)
  })

  it('differs for genuinely different content', () => {
    expect(contentHash('Title', 'one')).not.toBe(contentHash('Title', 'two'))
  })
})

describe('deriveTrust', () => {
  const internalActors = ['Alice', 'bob']
  const knownExternalActors = ['carol']

  it('matches internal case-insensitively', () => {
    expect(deriveTrust({ actorHandle: 'ALICE', internalActors })).toBe('internal')
  })

  it('matches known_external', () => {
    expect(deriveTrust({ actorHandle: 'Carol', knownExternalActors })).toBe('known_external')
  })

  it('falls through to anonymous', () => {
    expect(deriveTrust({ actorHandle: 'stranger', internalActors, knownExternalActors })).toBe(
      'anonymous',
    )
  })

  it('prefers internal when a handle is in both lists', () => {
    expect(
      deriveTrust({ actorHandle: 'bob', internalActors, knownExternalActors: ['bob'] }),
    ).toBe('internal')
  })
})

describe('unitKey', () => {
  it('keys on threadKey when present — a 14-reply thread is one unit of work', () => {
    const k = unitKey({ source: 'slack', sourceRef: 'msg:99', threadKey: 'C1:172.5' })
    expect(k).toBe('slack:C1:172.5')
    expect(unitKey({ source: 'slack', sourceRef: 'msg:100', threadKey: 'C1:172.5' })).toBe(k)
  })

  it('falls back to sourceRef when there is no thread', () => {
    expect(unitKey({ source: 'github', sourceRef: 'issue:1041', threadKey: null })).toBe(
      'github:issue:1041',
    )
  })
})

describe('normalize', () => {
  it('produces a valid NormalizedEvent with trimmed title and stripped body', () => {
    const n = normalize(raw({ body: 'mine\n> quoted' }), { id: FIXED_ID })
    expect(n.id).toBe(FIXED_ID)
    expect(n.title).toBe('Crash in getSessionId')
    expect(n.body).toBe('mine')
    expect(n.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(n.trust).toBe('anonymous')
    expect(n.injectionSuspected).toBe(false)
  })

  it('hashes the stripped body, not the raw one', () => {
    const n = normalize(raw({ body: 'mine\n> quoted' }), { id: FIXED_ID })
    expect(n.contentHash).toBe(contentHash('Crash in getSessionId', 'mine'))
  })

  it('runs extraction over the normalized text', () => {
    const n = normalize(raw(), { id: FIXED_ID })
    expect(n.extracted.symbols).toContain('src/auth/session.ts')
  })

  it('honours internalActors from config rather than hardcoding', () => {
    const n = normalize(raw(), { id: FIXED_ID, internalActors: ['octocat'] })
    expect(n.trust).toBe('internal')
  })

  it('carries injectionSuspected through — layer 1 of §15.3', () => {
    const n = normalize(raw(), { id: FIXED_ID, injectionSuspected: true })
    expect(n.injectionSuspected).toBe(true)
  })

  it('is deterministic given the same input and id', () => {
    const a = normalize(raw(), { id: FIXED_ID })
    const b = normalize(raw(), { id: FIXED_ID })
    expect(a).toEqual(b)
  })

  it('mints a uuid when none is supplied', () => {
    const n = normalize(raw())
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(n.id).not.toBe(normalize(raw()).id)
  })

  it('rejects a raw event missing required fields', () => {
    expect(() => normalize({ ...raw(), sourceRef: '' })).toThrow()
  })
})
