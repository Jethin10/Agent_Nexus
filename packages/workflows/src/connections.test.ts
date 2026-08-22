import { beforeEach, describe, expect, it, vi } from 'vitest'

const backing = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@ascendant/db', () => ({
  readConfig: vi.fn(async (_db: unknown, orgId: string, key: string, fallback: unknown) =>
    backing.has(`${orgId}:${key}`) ? backing.get(`${orgId}:${key}`) : fallback),
  writeConfig: vi.fn(async (_db: unknown, orgId: string, key: string, value: unknown) => {
    backing.set(`${orgId}:${key}`, value)
  }),
}))

import {
  ConnectionError,
  connectionForOrg,
  connectionSummaries,
  decryptConnection,
  deleteConnection,
  encryptConnection,
  saveConnection,
} from './connections.js'
import type { Db } from '@ascendant/db'

const database = {} as Db
const key = Buffer.alloc(32, 7).toString('base64')

beforeEach(() => {
  backing.clear()
  vi.stubEnv('ASCENDANT_CONNECTIONS_KEY', key)
})

describe('encrypted organization connections', () => {
  it('round-trips an AES-256-GCM envelope without exposing the secret', () => {
    const connection = {
      provider: 'slack' as const,
      botToken: 'xoxb-super-secret',
      channelId: 'C123',
      teamId: 'T123',
    }
    const encrypted = encryptConnection(connection, 'org_1', 'slack')

    expect(encrypted).toMatchObject({ v: 1, alg: 'A256GCM' })
    expect(JSON.stringify(encrypted)).not.toContain(connection.botToken)
    expect(decryptConnection(encrypted, 'org_1', 'slack')).toEqual(connection)
  })

  it('binds ciphertext to the organization and provider with authenticated data', () => {
    const encrypted = encryptConnection({
      provider: 'gmail', refreshToken: 'refresh', email: 'dev@acme.test',
    }, 'org_1', 'gmail')

    expect(() => decryptConnection(encrypted, 'org_2', 'gmail')).toThrow(ConnectionError)
    expect(() => decryptConnection(encrypted, 'org_1', 'slack')).toThrow(ConnectionError)
  })

  it('rejects tampering and incorrectly sized keys without leaking cryptographic details', () => {
    const encrypted = encryptConnection({
      provider: 'gmail', refreshToken: 'refresh', email: 'dev@acme.test',
    }, 'org_1', 'gmail')
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -1)}A` }
    expect(() => decryptConnection(tampered, 'org_1', 'gmail')).toThrow('Connection could not be decrypted')
    expect(() => encryptConnection(
      { provider: 'gmail', refreshToken: 'x', email: 'a@b.test' },
      'org_1',
      'gmail',
      Buffer.alloc(16).toString('base64'),
    )).toThrow('must be 32 bytes')
  })

  it('persists provider records and returns only secret-free summaries', async () => {
    await saveConnection(database, 'org_1', {
      provider: 'github', installationId: 42, owner: 'acme', repo: 'api', defaultBranch: 'trunk',
    })
    await saveConnection(database, 'org_1', {
      provider: 'slack', botToken: 'xoxb-secret', channelId: 'C1', teamId: 'T1', teamName: 'Acme', reviewerIds: ['U1'],
    })

    await expect(connectionForOrg(database, 'org_1', 'github')).resolves.toMatchObject({
      installationId: 42, owner: 'acme', repo: 'api',
    })
    const summaries = await connectionSummaries(database, 'org_1')
    expect(summaries).toEqual([
      { provider: 'github', connected: true, installationId: 42, owner: 'acme', repo: 'api', defaultBranch: 'trunk' },
      { provider: 'slack', connected: true, channelId: 'C1', teamId: 'T1', teamName: 'Acme', reviewerCount: 1 },
    ])
    expect(JSON.stringify(summaries)).not.toContain('xoxb-secret')
  })

  it('persists a GitHub installation without activating an arbitrary repository', async () => {
    await saveConnection(database, 'org_1', { provider: 'github', installationId: 42, accountLogin: 'acme' })
    await expect(connectionForOrg(database, 'org_1', 'github')).resolves.toEqual({
      provider: 'github', installationId: 42, accountLogin: 'acme',
    })
  })

  it('uses a null tombstone when a provider is disconnected', async () => {
    await saveConnection(database, 'org_1', {
      provider: 'gmail', refreshToken: 'refresh', email: 'dev@acme.test',
    })
    await deleteConnection(database, 'org_1', 'gmail')
    await expect(connectionForOrg(database, 'org_1', 'gmail')).resolves.toBeUndefined()
  })
})
