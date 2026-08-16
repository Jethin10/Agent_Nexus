import { describe, expect, it, vi } from 'vitest'
import { gmailMessageToRaw, gmailReader } from './index.js'

const encoded = (value: string) => Buffer.from(value).toString('base64url')

describe('gmailMessageToRaw', () => {
  it('preserves the Gmail thread and extracts a plain-text conversation', () => {
    const event = gmailMessageToRaw({
      id: 'm-1',
      threadId: 't-1',
      internalDate: '1700000000000',
      payload: {
        headers: [
          { name: 'Subject', value: 'Session API is failing' },
          { name: 'From', value: 'Asha <asha@example.com>' },
        ],
        parts: [{ mimeType: 'text/plain', body: { data: encoded('Exact repro in getSessionId') } }],
      },
    }, 'org_demo')

    expect(event).toMatchObject({
      source: 'gmail',
      sourceRef: 'gmail:m-1',
      threadKey: 'gmail:t-1',
      kind: 'email',
      title: 'Session API is failing',
      body: 'Exact repro in getSessionId',
      actor: { id: 'asha@example.com', handle: 'Asha' },
    })
  })
})

describe('gmailReader', () => {
  it('uses a refresh token and imports only the configured query', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'm-1' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'm-1', threadId: 't-1', payload: { headers: [{ name: 'Subject', value: 'Bug' }] },
      }), { status: 200 }))

    const events = await gmailReader({
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh',
      query: 'label:ascendant', fetcher,
    }).read('org_demo')

    expect(events).toHaveLength(1)
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('q=label%3Aascendant')
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ headers: { authorization: 'Bearer access' } })
  })
})
