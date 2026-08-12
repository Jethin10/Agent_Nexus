import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  insertEvent: vi.fn(),
}))

vi.mock('@ascendant/core', () => ({
  normalize: (raw: Record<string, unknown>) => ({ ...raw, id: 'normalized-event' }),
}))

vi.mock('@ascendant/connectors', () => ({
  githubConnector: () => ({
    verify: vi.fn().mockResolvedValue(true),
    parse: vi.fn().mockResolvedValue([
      {
        orgId: 'org_live',
        source: 'github',
        sourceRef: 'acme/api#42',
        kind: 'issue',
        title: 'Real issue',
        body: 'A sufficiently detailed issue body for triage.',
      },
    ]),
  }),
}))

vi.mock('@ascendant/db', () => ({
  db: () => ({ id: 'db' }),
  insertEvent: mocks.insertEvent,
  readPolicy: vi.fn().mockResolvedValue({
    internalActors: [],
    knownExternalActors: [],
  }),
}))

vi.mock('@ascendant/router', () => ({
  scanForInjection: vi.fn().mockResolvedValue({ suspected: false }),
}))

vi.mock('@ascendant/workflows', () => ({
  inngest: { send: mocks.send },
}))

vi.mock('@/lib/org', () => ({
  currentOrgId: () => 'org_live',
}))

import { POST } from './route.js'

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  source: 'github',
  sourceRef: 'acme/api#42',
}

beforeEach(() => {
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'webhook-secret')
  mocks.send.mockReset().mockResolvedValue({ ids: ['inngest-id'] })
  mocks.insertEvent
    .mockReset()
    .mockResolvedValueOnce({ row, inserted: true })
    .mockResolvedValueOnce({ row, inserted: false })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GitHub webhook dispatch recovery', () => {
  it('resends an existing row with the same Inngest idempotency key', async () => {
    const request = () =>
      new Request('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-42',
          'x-hub-signature-256': 'sha256=accepted-by-mock',
        },
        body: JSON.stringify({ action: 'opened' }),
      })

    expect((await POST(request())).status).toBe(202)
    expect((await POST(request())).status).toBe(202)

    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(mocks.send).toHaveBeenNthCalledWith(1, {
      id: `ascendant:event:${row.id}`,
      name: 'event/received',
      data: {
        orgId: 'org_live',
        eventId: row.id,
        source: 'github',
        sourceRef: 'acme/api#42',
      },
    })
    expect(mocks.send.mock.calls[1]?.[0]).toEqual(mocks.send.mock.calls[0]?.[0])
  })
})
