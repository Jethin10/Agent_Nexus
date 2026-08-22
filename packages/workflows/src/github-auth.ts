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

export interface GithubInstallationTokenOptions {
  appId: string
  /** Base64-encoded PEM private key from the GitHub App settings page. */
  privateKeyBase64: string
  installationId: number
  repositories?: string[]
  fetcher?: typeof fetch
  now?: Date
}

export interface GithubInstallationRepository {
  id: number
  name: string
  fullName: string
  owner: string
  private: boolean
  defaultBranch: string
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
  const installationId = installation.id as number

  return githubInstallationToken({
    appId: opts.appId,
    privateKeyBase64: opts.privateKeyBase64,
    installationId,
    repositories: [opts.repo],
    fetcher,
    now: opts.now,
  })
}

/** Mints a short-lived token from the installation id persisted after OAuth setup. */
export async function githubInstallationToken(opts: GithubInstallationTokenOptions): Promise<string> {
  if (!Number.isSafeInteger(opts.installationId) || opts.installationId <= 0) {
    throw new GithubAuthError('GitHub installation id must be a positive integer')
  }
  const fetcher = opts.fetcher ?? fetch
  const jwt = signAppJwt(opts.appId, opts.privateKeyBase64, opts.now ?? new Date())
  const tokenResponse = await fetcher(`${API}/app/installations/${opts.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': API_VERSION,
      'content-type': 'application/json',
    },
    ...(opts.repositories?.length
      ? { body: JSON.stringify({ repositories: opts.repositories }) }
      : {}),
  })
  const body = await readJson<{ token?: string }>(tokenResponse, 'mint installation token')
  if (!body.token) throw new GithubAuthError('GitHub returned an empty installation token')
  return body.token
}

/** Lists repositories visible to an already-minted installation token. */
export async function listInstallationRepositories(opts: {
  token: string
  fetcher?: typeof fetch
}): Promise<GithubInstallationRepository[]> {
  const fetcher = opts.fetcher ?? fetch
  const out: GithubInstallationRepository[] = []
  for (let page = 1; ; page += 1) {
    const response = await fetcher(`${API}/installation/repositories?per_page=100&page=${page}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${opts.token}`,
        'x-github-api-version': API_VERSION,
      },
    })
    const body = await readJson<{
      repositories?: Array<{
        id?: number
        name?: string
        full_name?: string
        private?: boolean
        default_branch?: string
        owner?: { login?: string }
      }>
    }>(response, 'list installation repositories')
    const repositories = body.repositories ?? []
    for (const repo of repositories) {
      if (!Number.isSafeInteger(repo.id) || !repo.name || !repo.owner?.login) continue
      out.push({
        id: repo.id!,
        name: repo.name,
        fullName: repo.full_name ?? `${repo.owner.login}/${repo.name}`,
        owner: repo.owner.login,
        private: repo.private ?? false,
        defaultBranch: repo.default_branch ?? 'main',
      })
    }
    if (repositories.length < 100) return out
  }
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
