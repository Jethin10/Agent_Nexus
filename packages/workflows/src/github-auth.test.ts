import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  githubAppInstallationToken,
  githubInstallationToken,
  listInstallationRepositories,
  signAppJwt,
} from './github-auth.js'
import { repoFromEnv } from './repo.js'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const PRIVATE_KEY_BASE64 = Buffer.from(PRIVATE_KEY).toString('base64')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('GitHub App authentication', () => {
  it('signs the bounded JWT GitHub requires', () => {
    const now = new Date('2026-08-12T12:00:00.000Z')
    const token = signAppJwt('12345', PRIVATE_KEY_BASE64, now)
    const [header, payload, signature] = token.split('.')

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      iat: Math.floor(now.getTime() / 1000) - 60,
      exp: Math.floor(now.getTime() / 1000) + 540,
      iss: '12345',
    })
    expect(signature).toBeTruthy()
  })

  it('looks up the repository installation and returns its short-lived token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 987 }))
      .mockResolvedValueOnce(Response.json({ token: 'ghs_installation_token', expires_at: '2026-08-12T13:00:00Z' }))

    await expect(
      githubAppInstallationToken({
        appId: '12345',
        privateKeyBase64: PRIVATE_KEY_BASE64,
        owner: 'acme',
        repo: 'api',
        fetcher,
        now: new Date('2026-08-12T12:00:00Z'),
      }),
    ).resolves.toBe('ghs_installation_token')

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/acme/api/installation')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.github.com/app/installations/987/access_tokens')
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ repositories: ['api'] }),
    })
    const authorization = (fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization
    expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/)
  })

  it('fails without leaking credentials when GitHub refuses the installation lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
    )

    await expect(
      githubAppInstallationToken({
        appId: '12345',
        privateKeyBase64: PRIVATE_KEY_BASE64,
        owner: 'acme',
        repo: 'missing',
        fetcher,
      }),
    ).rejects.toMatchObject({
      name: 'GithubAuthError',
      status: 404,
    })
  })

  it('mints directly from a persisted installation id without a repository lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: 'ghs_fresh' }))
    await expect(githubInstallationToken({
      appId: '12345',
      privateKeyBase64: PRIVATE_KEY_BASE64,
      installationId: 987,
      repositories: ['api'],
      fetcher,
      now: new Date('2026-08-12T12:00:00Z'),
    })).resolves.toBe('ghs_fresh')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/app/installations/987/access_tokens')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ repositories: ['api'] }) })
  })

  it('lists and normalizes repositories available to an installation token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ repositories: [{
      id: 7,
      name: 'api',
      full_name: 'acme/api',
      private: true,
      default_branch: 'trunk',
      owner: { login: 'acme' },
    }] }))
    await expect(listInstallationRepositories({ token: 'ghs_short', fetcher })).resolves.toEqual([{
      id: 7,
      name: 'api',
      fullName: 'acme/api',
      owner: 'acme',
      private: true,
      defaultBranch: 'trunk',
    }])
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ghs_short')
  })

  it('rejects malformed app credentials before any network request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      githubAppInstallationToken({
        appId: 'not-a-number',
        privateKeyBase64: Buffer.from('not a key').toString('base64'),
        owner: 'acme',
        repo: 'api',
        fetcher,
      }),
    ).rejects.toThrow('GITHUB_APP_ID must be numeric')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('prefers GitHub App credentials over a developer token', async () => {
    vi.stubEnv('GITHUB_OWNER', 'acme')
    vi.stubEnv('GITHUB_REPO', 'api')
    vi.stubEnv('GITHUB_APP_ID', '12345')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_BASE64', PRIVATE_KEY_BASE64)
    vi.stubEnv('GITHUB_TOKEN', 'developer-token-must-not-be-used')
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 987 }))
      .mockResolvedValueOnce(Response.json({ token: 'ghs_short_lived' }))
    vi.stubGlobal('fetch', fetcher)

    await expect(repoFromEnv()).resolves.toMatchObject({
      owner: 'acme',
      repo: 'api',
      token: 'ghs_short_lived',
      auth: 'app',
    })
  })

  it('fails closed when only half of the GitHub App credentials are configured', async () => {
    vi.stubEnv('GITHUB_OWNER', 'acme')
    vi.stubEnv('GITHUB_REPO', 'api')
    vi.stubEnv('GITHUB_APP_ID', '12345')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_BASE64', '')
    vi.stubEnv('GITHUB_TOKEN', 'developer-token')

    await expect(repoFromEnv()).rejects.toThrow('GitHub App authentication is incomplete')
  })

  it('rejects an implicit static-token fallback', async () => {
    vi.stubEnv('GITHUB_OWNER', 'acme')
    vi.stubEnv('GITHUB_REPO', 'api')
    vi.stubEnv('GITHUB_APP_ID', '')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_BASE64', '')
    vi.stubEnv('GITHUB_TOKEN', 'developer-token')
    vi.stubEnv('ASCENDANT_ALLOW_GITHUB_TOKEN', '')

    await expect(repoFromEnv()).rejects.toThrow('GITHUB_TOKEN is disabled')
  })

  it('allows a static token only behind the explicit local-development flag', async () => {
    vi.stubEnv('GITHUB_OWNER', 'acme')
    vi.stubEnv('GITHUB_REPO', 'api')
    vi.stubEnv('GITHUB_APP_ID', '')
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_BASE64', '')
    vi.stubEnv('GITHUB_TOKEN', 'developer-token')
    vi.stubEnv('ASCENDANT_ALLOW_GITHUB_TOKEN', '1')

    await expect(repoFromEnv()).resolves.toMatchObject({
      token: 'developer-token',
      auth: 'token',
    })
  })
})
