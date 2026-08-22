import { cookies } from 'next/headers'
import {
  githubInstallationToken,
  listInstallationRepositories,
  saveConnection,
} from '@ascendant/workflows'
import { db } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'
import { failOAuth, finishOAuth } from '@/lib/connect-response'
import { oauthStateCookieName, verifyOAuthState } from '@/lib/oauth-state'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  try {
    const cookie = (await cookies()).get(oauthStateCookieName('github'))?.value
    const { returnTo } = verifyOAuthState(requestUrl.searchParams.get('state'), cookie, 'github')
    const installationId = Number(requestUrl.searchParams.get('installation_id'))
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('GitHub did not return a valid installation')
    }
    const appId = requireEnv('GITHUB_APP_ID')
    const privateKeyBase64 = requireEnv('GITHUB_APP_PRIVATE_KEY_BASE64')
    const token = await githubInstallationToken({ appId, privateKeyBase64, installationId })
    const repositories = await listInstallationRepositories({ token })
    if (repositories.length === 0) throw new Error('Install Ascendant on at least one GitHub repository')
    const repository = repositories.length === 1 ? repositories[0] : undefined

    await ensureDb()
    await saveConnection(db(), currentOrgId(), {
      provider: 'github',
      installationId,
      accountLogin: repositories[0]?.owner,
      ...(repository ? {
        owner: repository.owner,
        repo: repository.name,
        defaultBranch: repository.defaultBranch,
      } : {}),
    })
    return finishOAuth(request.url, returnTo, 'github')
  } catch (error) {
    return failOAuth(request.url, 'github', error)
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}
