import { signAppJwt, type Connection } from '@ascendant/workflows'

interface RevokeOptions {
  fetcher?: typeof fetch
  env?: Readonly<Record<string, string | undefined>>
  now?: Date
}

/** Revoke the provider-side grant before removing Ascendant's encrypted record. */
export async function revokeProviderConnection(
  connection: Connection,
  options: RevokeOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const env = options.env ?? process.env

  if (connection.provider === 'github') {
    const appId = required(env, 'GITHUB_APP_ID')
    const key = required(env, 'GITHUB_APP_PRIVATE_KEY_BASE64')
    const jwt = signAppJwt(appId, key, options.now ?? new Date())
    const response = await fetcher(
      `https://api.github.com/app/installations/${connection.installationId}`,
      {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    )
    if (!response.ok) throw new Error(`GitHub App uninstall failed (HTTP ${response.status})`)
    return
  }

  if (connection.provider === 'slack') {
    const response = await fetcher('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: connection.botToken }),
    })
    const body = await response.json() as { ok?: boolean; error?: string }
    if (!response.ok || !body.ok) {
      throw new Error(`Slack revocation failed${body.error ? `: ${body.error}` : ` (HTTP ${response.status})`}`)
    }
    return
  }

  const response = await fetcher('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: connection.refreshToken }),
  })
  if (!response.ok) throw new Error(`Google revocation failed (HTTP ${response.status})`)
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}
