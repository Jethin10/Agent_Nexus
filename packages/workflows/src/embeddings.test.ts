import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '@ascendant/db/local'
import { embeddings, events } from '@ascendant/db'
import { eq } from 'drizzle-orm'
import {
  PRODUCTION_EMBEDDING_DIMENSIONS,
  PRODUCTION_EMBEDDING_MODEL,
  embedEvent,
  embedText,
  eventsMissingProductionEmbedding,
} from './embeddings.js'

let handle: LocalDbHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

const vector = Array.from({ length: PRODUCTION_EMBEDDING_DIMENSIONS }, (_, i) => i / 1000)
const response = () => Response.json({ embedding: { values: vector } })

describe('production embeddings', () => {
  it('requests a 768-dimensional retrieval embedding from Gemini', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response())
    await expect(embedText({
      apiKey: 'test-key',
      text: 'session expiry crash',
      title: 'Crash report',
      task: 'RETRIEVAL_DOCUMENT',
      fetcher,
    })).resolves.toHaveLength(768)

    expect(fetcher).toHaveBeenCalledWith(
      `https://generativelanguage.googleapis.com/v1beta/models/${PRODUCTION_EMBEDDING_MODEL}:embedContent`,
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      model: `models/${PRODUCTION_EMBEDDING_MODEL}`,
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
      title: 'Crash report',
    })
  })

  it('rejects an embedding with the wrong dimensionality', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ embedding: { values: [0.1, 0.2] } }),
    )
    await expect(embedText({
      apiKey: 'test-key',
      text: 'query',
      task: 'RETRIEVAL_QUERY',
      fetcher,
    })).rejects.toThrow('expected 768')
  })

  it('upserts event vectors and removes them from the repair queue', async () => {
    handle = await makeLocalDb()
    await applyMigrations(handle.db)
    const eventId = '11111111-1111-4111-8111-111111111111'
    const [event] = await handle.db.insert(events).values({
      id: eventId,
      orgId: 'org_live',
      source: 'github',
      sourceRef: 'acme/api#42',
      kind: 'issue',
      unitKey: 'github:acme/api#42',
      threadKey: 'acme/api#42',
      actorId: '7',
      actorHandle: 'octocat',
      actorIsBot: false,
      title: 'Crash on expiry',
      body: 'The API crashes when an expired session reaches the authentication middleware.',
      contentHash: 'a'.repeat(64),
      extracted: { urls: [], issueRefs: [], symbols: [], stackFrames: [], versions: [] },
      trust: 'known_external',
      injectionSuspected: false,
      attachments: [],
      raw: {},
      createdAt: new Date('2026-08-12T00:00:00Z'),
    }).returning()
    expect(event).toBeTruthy()
    expect(await eventsMissingProductionEmbedding(handle.db, 'org_live')).toHaveLength(1)

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response())
    await embedEvent(handle.db, event!, { apiKey: 'test-key', fetcher })
    await embedEvent(handle.db, event!, { apiKey: 'test-key', fetcher })

    expect(await eventsMissingProductionEmbedding(handle.db, 'org_live')).toHaveLength(0)
    const rows = await handle.db.select().from(embeddings).where(eq(embeddings.entityId, eventId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: PRODUCTION_EMBEDDING_MODEL, content: expect.stringContaining('Crash on expiry') })
    expect(rows[0]?.vec768).toHaveLength(768)
  }, 15_000)
})
