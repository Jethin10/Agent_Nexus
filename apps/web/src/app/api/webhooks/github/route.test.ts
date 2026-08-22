import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  insertEvent: vi.fn(),
  parse: vi.fn(),
  connectionForOrg: vi.fn(),
}))

vi.mock('@ascendant/core', () => ({
  normalize: (raw: Record<string, unknown>) => ({ ...raw, id: 'normalized-event' }),
}))

vi.mock('@ascendant/connectors', () => ({
  githubConnector: () => ({
    verify: vi.fn().mockResolvedValue(true),
    parse: mocks.parse,
  }),
  isGithubRepositoryRef: (
    sourceRef: string,
    expected: { owner: string; repo: string },
  ) => sourceRef.toLowerCase().startsWith(`${expected.owner}/${expected.repo}`.toLowerCase()),
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
  connectionForOrg: mocks.connectionForOrg,
}))

vi.mock('@/lib/org', () => ({
  currentOrgId: () => 'org_live',
}))

vi.mock('@/lib/local-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from './route.js'

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  source: 'github',
  sourceRef: 'acme/api#42',
}

beforeEach(() => {
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'webhook-secret')
  vi.stubEnv('GITHUB_OWNER', 'acme')
  vi.stubEnv('GITHUB_REPO', 'api')
  mocks.parse.mockReset().mockResolvedValue([
    {
      orgId: 'org_live',
      source: 'github',
      sourceRef: 'acme/api#42',
      kind: 'issue',
      title: 'Real issue',
      body: 'A sufficiently detailed issue body for triage.',
    },
  ])
  mocks.send.mockReset().mockResolvedValue({ ids: ['inngest-id'] })
  mocks.connectionForOrg.mockReset().mockResolvedValue(undefined)
  mocks.insertEvent
    .mockReset()
    .mockResolvedValueOnce({ row, inserted: true })
    .mockResolvedValueOnce({ row, inserted: false })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GitHub webhook dispatch recovery', () => {
  const request = (payload: Record<string, unknown> = { action: 'opened' }) =>
    new Request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-42',
        'x-hub-signature-256': 'sha256=accepted-by-mock',
      },
      body: JSON.stringify(payload),
    })

  it('resends an existing row with the same Inngest idempotency key', async () => {
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

  it('rejects a valid App webhook from a different repository before persistence', async () => {
    mocks.parse.mockResolvedValueOnce([
      {
        orgId: 'org_live',
        source: 'github',
        sourceRef: 'other/repo#42',
        kind: 'issue',
        title: 'Cross-repository issue',
        body: 'This must not create work against acme/api.',
      },
    ])

    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(mocks.insertEvent).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('uses the persisted installation and repository instead of stale env selection', async () => {
    mocks.connectionForOrg.mockResolvedValue({
      provider: 'github', installationId: 99, owner: 'connected', repo: 'project',
    })
    mocks.parse.mockResolvedValueOnce([{
      orgId: 'org_live', source: 'github', sourceRef: 'connected/project#7',
      kind: 'issue', title: 'Connected issue', body: 'Authorized through the installed app.',
    }])
    const response = await POST(request({ action: 'opened', installation: { id: 99 } }))
    expect(response.status).toBe(202)
    expect(mocks.insertEvent).toHaveBeenCalledOnce()
  })

  it('rejects a webhook signed for a different GitHub App installation', async () => {
    mocks.connectionForOrg.mockResolvedValue({
      provider: 'github', installationId: 99, owner: 'connected', repo: 'project',
    })
    const response = await POST(request({ action: 'opened', installation: { id: 100 } }))
    expect(response.status).toBe(403)
    expect(mocks.insertEvent).not.toHaveBeenCalled()
  })
})
