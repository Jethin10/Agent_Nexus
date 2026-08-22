import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readConfig, writeConfig, type Db } from '@ascendant/db'

export type ConnectionProvider = 'github' | 'slack' | 'gmail'

export interface GithubConnection {
  provider: 'github'
  installationId: number
  /** Set only after the operator explicitly selects an installed repository. */
  owner?: string
  repo?: string
  defaultBranch?: string
  accountLogin?: string
}

export interface SlackConnection {
  provider: 'slack'
  botToken: string
  channelId: string
  teamId: string
  teamName?: string
  /** Slack members allowed to resolve review buttons; the installer is added by OAuth. */
  reviewerIds?: string[]
}

export interface GmailConnection {
  provider: 'gmail'
  refreshToken: string
  email: string
  scope?: string[]
}

export type Connection = GithubConnection | SlackConnection | GmailConnection

interface EncryptedConnection {
  v: 1
  alg: 'A256GCM'
  iv: string
  tag: string
  ciphertext: string
}

const KEY_PREFIX = 'integrations.connection.'

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionError'
  }
}

/** Persist one provider grant. Secrets never enter a plaintext database column. */
export async function saveConnection(db: Db, orgId: string, connection: Connection): Promise<void> {
  validateConnection(connection)
  const value = encryptConnection(connection, orgId, connection.provider)
  await writeConfig(db, orgId, configKey(connection.provider), value, {
    note: `${connection.provider} OAuth connection (AES-256-GCM encrypted)`,
    updatedBy: 'oauth',
  })
}

export async function connectionForOrg(
  db: Db,
  orgId: string,
  provider: 'github',
): Promise<GithubConnection | undefined>
export async function connectionForOrg(
  db: Db,
  orgId: string,
  provider: 'slack',
): Promise<SlackConnection | undefined>
export async function connectionForOrg(
  db: Db,
  orgId: string,
  provider: 'gmail',
): Promise<GmailConnection | undefined>
export async function connectionForOrg(
  db: Db,
  orgId: string,
  provider: ConnectionProvider,
): Promise<Connection | undefined>
export async function connectionForOrg(
  db: Db,
  orgId: string,
  provider: ConnectionProvider,
): Promise<Connection | undefined> {
  const stored = await readConfig<EncryptedConnection | null>(db, orgId, configKey(provider), null)
  if (!stored) return undefined
  const connection = decryptConnection(stored, orgId, provider)
  validateConnection(connection)
  if (connection.provider !== provider) throw new ConnectionError('Connection provider did not match its storage key')
  return connection
}

/** Removing a connection uses a null tombstone because config has no delete query. */
export async function deleteConnection(db: Db, orgId: string, provider: ConnectionProvider): Promise<void> {
  await writeConfig(db, orgId, configKey(provider), null, {
    note: `${provider} OAuth connection removed`,
    updatedBy: 'oauth',
  })
}

export type ConnectionSummary =
  | { provider: 'github'; connected: true; installationId: number; owner?: string; repo?: string; defaultBranch?: string; accountLogin?: string }
  | { provider: 'slack'; connected: true; channelId: string; teamId: string; teamName?: string; reviewerCount?: number }
  | { provider: 'gmail'; connected: true; email: string; scope?: string[] }

/** UI-safe provider metadata. Tokens and encrypted envelopes are never returned. */
export async function connectionSummaries(db: Db, orgId: string): Promise<ConnectionSummary[]> {
  // Keep local PGlite reads serial. Its WASM-backed ArrayBuffers cannot be transferred
  // by multiple concurrent React server renders, while production Neon remains fast
  // because this page performs only three indexed config lookups.
  const records: Array<Connection | undefined> = []
  records.push(await connectionForOrg(db, orgId, 'github'))
  records.push(await connectionForOrg(db, orgId, 'slack'))
  records.push(await connectionForOrg(db, orgId, 'gmail'))
  return records.filter((record): record is Connection => Boolean(record)).map((record) => {
    if (record.provider === 'github') {
      const { installationId, owner, repo, defaultBranch, accountLogin } = record
      return { provider: 'github', connected: true, installationId, owner, repo, ...(defaultBranch ? { defaultBranch } : {}), ...(accountLogin ? { accountLogin } : {}) }
    }
    if (record.provider === 'slack') {
      const { channelId, teamId, teamName, reviewerIds } = record
      return {
        provider: 'slack',
        connected: true,
        channelId,
        teamId,
        ...(teamName ? { teamName } : {}),
        ...(reviewerIds?.length ? { reviewerCount: reviewerIds.length } : {}),
      }
    }
    const { email, scope } = record
    return { provider: 'gmail', connected: true, email, ...(scope ? { scope } : {}) }
  })
}

export function encryptConnection(
  connection: Connection,
  orgId: string,
  provider: ConnectionProvider,
  keyValue = process.env.ASCENDANT_CONNECTIONS_KEY,
): EncryptedConnection {
  const key = connectionKey(keyValue)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${orgId}:${provider}:v1`))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(connection), 'utf8'), cipher.final()])
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

export function decryptConnection(
  envelope: EncryptedConnection,
  orgId: string,
  provider: ConnectionProvider,
  keyValue = process.env.ASCENDANT_CONNECTIONS_KEY,
): Connection {
  if (envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new ConnectionError('Unsupported connection envelope')
  try {
    const decipher = createDecipheriv('aes-256-gcm', connectionKey(keyValue), Buffer.from(envelope.iv, 'base64url'))
    decipher.setAAD(Buffer.from(`${orgId}:${provider}:v1`))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    return JSON.parse(plaintext) as Connection
  } catch (error) {
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError('Connection could not be decrypted; verify ASCENDANT_CONNECTIONS_KEY')
  }
}

function connectionKey(value: string | undefined): Buffer {
  if (!value) throw new ConnectionError('ASCENDANT_CONNECTIONS_KEY is not configured')
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) {
    throw new ConnectionError('ASCENDANT_CONNECTIONS_KEY must be 32 bytes encoded as base64 or 64 hex characters')
  }
  return key
}

function configKey(provider: ConnectionProvider): string {
  return `${KEY_PREFIX}${provider}`
}

function validateConnection(connection: Connection): void {
  if (!connection || !['github', 'slack', 'gmail'].includes(connection.provider)) {
    throw new ConnectionError('Connection provider is invalid')
  }
  if (connection.provider === 'github') {
    if (!Number.isSafeInteger(connection.installationId) || connection.installationId <= 0) {
      throw new ConnectionError('GitHub connection is incomplete')
    }
    if (Boolean(connection.owner) !== Boolean(connection.repo)) {
      throw new ConnectionError('GitHub repository selection is incomplete')
    }
  } else if (connection.provider === 'slack') {
    if (!connection.botToken || !connection.channelId || !connection.teamId) throw new ConnectionError('Slack connection is incomplete')
    if (connection.reviewerIds?.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new ConnectionError('Slack reviewer ids are invalid')
    }
  } else if (!connection.refreshToken || !connection.email) {
    throw new ConnectionError('Gmail connection is incomplete')
  }
}
