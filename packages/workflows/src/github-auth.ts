import { createSign } from 'node:crypto'

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'

export class GithubAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GithubAuthError'
  }
}

export interface GithubAppTokenOptions {
  appId: string
  /** Base64-encoded PEM private key from the GitHub App settings page. */
  privateKeyBase64: string
  owner: string
  repo: string
  fetcher?: typeof fetch
  now?: Date
}

/**
 * Mints a repository-scoped GitHub App installation token.
 *
 * The app JWT lives for nine minutes and is used only to request the installation
 * token. GitHub controls that token's permissions and one-hour expiry. Neither token
 * is persisted, logged, or passed to an agent or sandbox.
 */
export async function githubAppInstallationToken(opts: GithubAppTokenOptions): Promise<string> {
  const fetcher = opts.fetcher ?? fetch
  const jwt = signAppJwt(opts.appId, opts.privateKeyBase64, opts.now ?? new Date())
  const appHeaders = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${jwt}`,
    'x-github-api-version': API_VERSION,
  }

  const installationResponse = await fetcher(
    `${API}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/installation`,
    { headers: appHeaders },
  )
  const installation = await readJson<{ id?: number }>(installationResponse, 'find repository installation')
  if (!Number.isSafeInteger(installation.id)) {
    throw new GithubAuthError('GitHub returned an installation without a valid id')
  }

  const tokenResponse = await fetcher(`${API}/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: { ...appHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: [opts.repo] }),
  })
  const body = await readJson<{ token?: string }>(tokenResponse, 'mint installation token')
  if (!body.token) throw new GithubAuthError('GitHub returned an empty installation token')
  return body.token
}

export function signAppJwt(appId: string, privateKeyBase64: string, now: Date): string {
  if (!/^\d+$/.test(appId)) throw new GithubAuthError('GITHUB_APP_ID must be numeric')

  let privateKey: string
  try {
    privateKey = Buffer.from(privateKeyBase64, 'base64').toString('utf8')
  } catch {
    throw new GithubAuthError('GITHUB_APP_PRIVATE_KEY_BASE64 is not valid base64')
  }
  if (!privateKey.includes('PRIVATE KEY')) {
    throw new GithubAuthError('GITHUB_APP_PRIVATE_KEY_BASE64 did not decode to a PEM private key')
  }

  const nowSeconds = Math.floor(now.getTime() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }))
  const unsigned = `${header}.${payload}`

  try {
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    signer.end()
    return `${unsigned}.${signer.sign(privateKey, 'base64url')}`
  } catch {
    throw new GithubAuthError('GitHub App private key could not sign an RS256 JWT')
  }
}

async function readJson<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new GithubAuthError(
      `GitHub could not ${action}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      response.status,
    )
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new GithubAuthError(`GitHub could not ${action}: response was not JSON`, response.status)
  }
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}
