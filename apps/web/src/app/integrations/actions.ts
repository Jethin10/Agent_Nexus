'use server'

import { revalidatePath } from 'next/cache'
import {
  connectionForOrg,
  deleteConnection,
  githubInstallationToken,
  listInstallationRepositories,
  saveConnection,
  type ConnectionProvider,
} from '@ascendant/workflows'
import { db } from '@ascendant/db'
import { ensureDb } from '@/lib/local-db'
import { currentOrgId } from '@/lib/org'
import { revokeProviderConnection } from '@/lib/revoke-connection'

export async function disconnectConnection(formData: FormData): Promise<void> {
  const provider = formData.get('provider')
  if (provider !== 'github' && provider !== 'slack' && provider !== 'gmail') {
    throw new Error('Unknown connection provider')
  }
  await ensureDb()
  const database = db()
  const orgId = currentOrgId()
  const connection = await connectionForOrg(database, orgId, provider)
  if (connection) await revokeProviderConnection(connection)
  await deleteConnection(database, orgId, provider satisfies ConnectionProvider)
  revalidatePath('/integrations')
}

export async function selectGithubRepository(formData: FormData): Promise<void> {
  const fullName = String(formData.get('repository') ?? '')
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw new Error('Select a valid repository')

  await ensureDb()
  const database = db()
  const orgId = currentOrgId()
  const current = await connectionForOrg(database, orgId, 'github')
  if (!current) throw new Error('Connect GitHub before selecting a repository')

  const token = await githubInstallationToken({
    appId: requireEnv('GITHUB_APP_ID'),
    privateKeyBase64: requireEnv('GITHUB_APP_PRIVATE_KEY_BASE64'),
    installationId: current.installationId,
  })
  const repositories = await listInstallationRepositories({ token })
  const selected = repositories.find((repository) => repository.fullName === fullName)
  if (!selected) throw new Error('That repository is not available to this GitHub App installation')

  await saveConnection(database, orgId, {
    ...current,
    owner: selected.owner,
    repo: selected.name,
    defaultBranch: selected.defaultBranch,
  })
  revalidatePath('/integrations')
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}
