import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { revokeProviderConnection } from './revoke-connection.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

describe('revokeProviderConnection', () => {
  it('uninstalls a GitHub App installation with an app JWT', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await revokeProviderConnection(
      { provider: 'github', installationId: 42, owner: 'acme', repo: 'api' },
      {
        fetcher,
        env: {
          GITHUB_APP_ID: '123',
          GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKeyPem).toString('base64'),
        },
      },
    )
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/42',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('revokes Slack and Google grants without putting tokens in URLs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    await revokeProviderConnection(
      { provider: 'slack', botToken: 'xoxb-secret', channelId: 'C1', teamId: 'T1' },
      { fetcher },
    )
    await revokeProviderConnection(
      { provider: 'gmail', refreshToken: 'google-secret', email: 'a@example.com' },
      { fetcher },
    )
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://slack.com/api/auth.revoke')
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('xoxb-secret')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://oauth2.googleapis.com/revoke')
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('google-secret')
  })

  it('keeps the local record intact when the provider refuses revocation', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: false, error: 'invalid_auth' }))
    await expect(revokeProviderConnection(
      { provider: 'slack', botToken: 'bad', channelId: 'C1', teamId: 'T1' },
      { fetcher },
    )).rejects.toThrow('invalid_auth')
  })
})
