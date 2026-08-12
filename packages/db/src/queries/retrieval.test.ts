import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalize, type RawEvent } from '@ascendant/core'
import { applyMigrations, hasVector, makeLocalDb, type LocalDbHandle } from '../local'
import type { Db } from '../client'
import { embeddings } from '../schema/embeddings'
import { insertEvent } from './events'
import { insertDecision } from './decisions'
import {
  decisionMemory,
  gitActivity,
  lexicalNeighbours,
  retrieveCandidates,
  vectorNeighbours,
} from './retrieval'

/**
 * The four retrieval queries (§5.3), against a real Postgres.
 *
 * These had never executed. They are the only part of the system whose correctness
 * lives in SQL rather than in TypeScript — pgvector's `<=>` operator, `ts_rank`, and
 * the jsonb `?|` overlap are all invisible to `tsc`, so a passing typecheck said
 * nothing about whether retrieval worked at all.
 *
 * PGlite is genuine Postgres compiled to WASM, so the operators exercised here are
 * the same implementations Neon runs. What this cannot prove is planner behaviour at
 * scale: HNSW recall on a 10k-row corpus is a property of the index, not of the query.
 */

const ORG = 'org_test'

/** Deterministic unit vectors. Angle is what matters — cosine ignores magnitude. */
function unitVec(dim: number, angle: number): number[] {
  const v = Array.from({ length: dim }, (_, i) =>
    i === 0 ? Math.cos(angle) : i === 1 ? Math.sin(angle) : 0,
  )
  return v
}

const VEC_A = unitVec(768, 0)
/** ~11.5° from A — inside decision memory's 0.15 cosine-distance bound (cos ≈ 0.98). */
const VEC_NEAR = unitVec(768, 0.2)
/** 90° from A: cosine distance exactly 1, far outside the bound. */
const VEC_FAR = unitVec(768, Math.PI / 2)

function rawEvent(over: Partial<RawEvent> & Pick<RawEvent, 'sourceRef' | 'title' | 'body'>): RawEvent {
  return {
    orgId: ORG,
    source: 'github',
    kind: 'issue',
    threadKey: null,
    actor: { id: '1', handle: 'alice', isBot: false },
    createdAt: new Date(),
    attachments: [],
    raw: null,
    ...over,
  } as RawEvent
}

async function addEmbedding(
  db: Db,
  row: { entityKind: string; entityId: string; content: string; vec768?: number[] },
): Promise<void> {
  await db.insert(embeddings).values({
    orgId: ORG,
    entityKind: row.entityKind,
    entityId: row.entityId,
    content: row.content,
    ...(row.vec768 ? { vec768: row.vec768 } : {}),
    model: 'test',
  })
}

describe('retrieval — against real Postgres (PGlite + pgvector)', () => {
  let handle: LocalDbHandle
  let db: Db

  beforeAll(async () => {
    handle = await makeLocalDb()
    db = handle.db
    await applyMigrations(handle.db)
  }, 120_000)

  afterAll(async () => {
    await handle?.close()
  })

  it('applies the full migration, including the hand-added vector extension (D2)', async () => {
    expect(await hasVector(handle.db)).toBe(true)
  })

  describe('source 1 — vectorNeighbours', () => {
    it('ranks by cosine similarity and converts distance to similarity', async () => {
      await addEmbedding(db, {
        entityKind: 'issue',
        entityId: 'vec:near',
        content: 'Session id crash on expired token',
        vec768: VEC_NEAR,
      })
      await addEmbedding(db, {
        entityKind: 'doc',
        entityId: 'vec:far',
        content: 'Unrelated document about billing',
        vec768: VEC_FAR,
      })

      const got = await vectorNeighbours(db, { orgId: ORG, vec: VEC_A, dim: 768 })

      // Nearest first. Reversing the distance-to-similarity conversion would
      // silently invert this and gut retrieval without failing any type check.
      expect(got.map((c) => c.entityId)).toEqual(['vec:near', 'vec:far'])
      expect(got[0]!.score).toBeGreaterThan(0.9)
      expect(got[1]!.score).toBeLessThan(0.1)
      expect(got[0]!.source).toBe('vector')
    })

    it('ignores rows whose vector column is null', async () => {
      await addEmbedding(db, {
        entityKind: 'issue',
        entityId: 'vec:novector',
        content: 'Has no embedding at all',
      })
      const got = await vectorNeighbours(db, { orgId: ORG, vec: VEC_A, dim: 768 })
      expect(got.map((c) => c.entityId)).not.toContain('vec:novector')
    })

    it('excludes the event being triaged from its own neighbour set', async () => {
      const got = await vectorNeighbours(db, {
        orgId: ORG,
        vec: VEC_A,
        dim: 768,
        excludeEntityId: 'vec:near',
      })
      expect(got.map((c) => c.entityId)).not.toContain('vec:near')
    })

    it('filters on org_id (§15.4)', async () => {
      await db.insert(embeddings).values({
        orgId: 'org_other',
        entityKind: 'issue',
        entityId: 'vec:otherorg',
        content: 'Belongs to a different tenant',
        vec768: VEC_A,
      })
      const got = await vectorNeighbours(db, { orgId: ORG, vec: VEC_A, dim: 768 })
      expect(got.map((c) => c.entityId)).not.toContain('vec:otherorg')
    })

    it('cites the upstream ref, not the internal uuid', async () => {
      /**
       * A citation is read by a human in the reject comment (§5.5) and matched by
       * validateCitations. `embeddings.entity_id` for an event is an internal uuid, so
       * surfacing it as the ref made every vector-sourced citation unreadable and
       * unmatchable — the model would be asked to cite `0b102ab6-…` instead of
       * `acme/api#412`.
       */
      const ev = normalize(
        rawEvent({
          sourceRef: 'acme/api#777',
          title: 'An event with an upstream ref',
          body: 'Body text for the embedding.',
        }),
      )
      const { row } = await insertEvent(db, ev)
      await addEmbedding(db, {
        entityKind: 'event',
        entityId: row.id,
        content: 'An event with an upstream ref',
        vec768: VEC_A,
      })

      const got = await vectorNeighbours(db, { orgId: ORG, vec: VEC_A, dim: 768 })
      const hit = got.find((c) => c.entityId === row.id)
      expect(hit).toBeDefined()
      expect(hit!.ref).toBe('acme/api#777')
      expect(hit!.ref).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    })

    it('falls back to the entity id for a non-event embedding', async () => {
      // Decision and doc-chunk embeddings have no upstream ref; the left join must
      // still return them rather than dropping them.
      await addEmbedding(db, {
        entityKind: 'decision',
        entityId: 'decision-fallback-id',
        content: 'REJECT: something previously refused',
        vec768: VEC_A,
      })
      const got = await vectorNeighbours(db, { orgId: ORG, vec: VEC_A, dim: 768, limit: 20 })
      const hit = got.find((c) => c.entityId === 'decision-fallback-id')
      expect(hit).toBeDefined()
      expect(hit!.ref).toBe('decision-fallback-id')
    })
  })

  describe('source 2 — lexicalNeighbours', () => {
    it('matches an exact error string that embeddings would blur', async () => {
      await addEmbedding(db, {
        entityKind: 'issue',
        entityId: 'lex:412',
        content: "TypeError: cannot read 'id' of undefined at apps/api/src/session.ts:88",
      })

      const got = await lexicalNeighbours(db, {
        orgId: ORG,
        terms: ['TypeError cannot read id of undefined'],
      })
      expect(got.map((c) => c.entityId)).toContain('lex:412')
      expect(got.find((c) => c.entityId === 'lex:412')!.source).toBe('lexical')
    })

    it('tolerates operator characters that would throw under to_tsquery', async () => {
      // websearch_to_tsquery is chosen precisely so a raw symbol list cannot crash
      // retrieval. Unbalanced quotes and stray operators must be survivable.
      await expect(
        lexicalNeighbours(db, {
          orgId: ORG,
          terms: ['session.ts && || !(', '"unbalanced', 'foo:*bar'],
        }),
      ).resolves.toBeInstanceOf(Array)
    })

    it('returns [] when every term is too short to search', async () => {
      const got = await lexicalNeighbours(db, { orgId: ORG, terms: ['a', 'b'] })
      expect(got).toEqual([])
    })
  })

  describe('source 3 — gitActivity ("already fixed on main")', () => {
    it('finds a merged PR whose extracted symbols overlap the issue', async () => {
      const pr = normalize(
        rawEvent({
          sourceRef: 'acme/api!88',
          kind: 'pr',
          title: 'Fix session id crash on expired token',
          body: 'Guards the null branch in `apps/api/src/session.ts`.',
          raw: { pull_request: { merged: true } },
        }),
      )
      await insertEvent(db, pr)

      const got = await gitActivity(db, {
        orgId: ORG,
        symbols: ['apps/api/src/session.ts'],
      })
      expect(got.map((c) => c.ref)).toContain('acme/api!88')
      const hit = got.find((c) => c.ref === 'acme/api!88')!
      expect(hit.source).toBe('git')
      expect(hit.kind).toBe('pr')
      expect(hit.score).toBeGreaterThan(0)
    })

    it('does not treat an open or closed-unmerged PR as shipped work', async () => {
      const pr = normalize(
        rawEvent({
          sourceRef: 'acme/api!89',
          kind: 'pr',
          title: 'Attempted session fix',
          body: 'Touches `apps/api/src/session.ts` but was not merged.',
          raw: { pull_request: { merged: false, merged_at: null } },
        }),
      )
      await insertEvent(db, pr)
      const got = await gitActivity(db, { orgId: ORG, symbols: ['apps/api/src/session.ts'] })
      expect(got.map((c) => c.ref)).not.toContain('acme/api!89')
    })

    it('respects the recency window — an old PR is not recent activity', async () => {
      const old = normalize(
        rawEvent({
          sourceRef: 'acme/api!12',
          kind: 'pr',
          title: 'Ancient fix touching the same file',
          body: 'Touches `apps/api/src/session.ts` but long ago.',
          createdAt: new Date(Date.now() - 90 * 86_400_000),
        }),
      )
      await insertEvent(db, old)

      const got = await gitActivity(db, {
        orgId: ORG,
        symbols: ['apps/api/src/session.ts'],
      })
      expect(got.map((c) => c.ref)).not.toContain('acme/api!12')
    })

    it('returns [] when the event extracted no symbols', async () => {
      expect(await gitActivity(db, { orgId: ORG, symbols: [] })).toEqual([])
    })
  })

  describe('source 4 — decisionMemory', () => {
    it('recalls a prior decision on a near-identical event and cites it', async () => {
      const prior = normalize(
        rawEvent({
          sourceRef: 'acme/api#301',
          title: 'Please add a GraphQL endpoint for sessions',
          body: 'We would like GraphQL for the session API.',
        }),
      )
      const { row } = await insertEvent(db, prior)
      await insertDecision(db, {
        orgId: ORG,
        eventId: row.id,
        outcome: 'REJECT',
        confidence: 0.89,
        reasoning:
          'This contradicts a documented architecture decision recorded on 2026-06-12 stating that no GraphQL layer will be added.',
        citations: [
          { kind: 'doc', ref: 'doc:adr-graphql', quote: 'we are not adding a GraphQL layer', why: 'Decision doc.' },
        ] as never,
        policyHits: [],
        autonomous: true,
        needsReview: false,
        modelUsed: 'test',
      })
      // Decision memory joins embeddings on the *event* id with entity_kind 'event'.
      await addEmbedding(db, {
        entityKind: 'event',
        entityId: row.id,
        content: 'Please add a GraphQL endpoint for sessions',
        vec768: VEC_A,
      })

      const got = await decisionMemory(db, { orgId: ORG, vec: VEC_NEAR, dim: 768 })
      expect(got).toHaveLength(1)
      expect(got[0]!.source).toBe('decision')
      expect(got[0]!.priorOutcome).toBe('REJECT')
      // The content is what makes a re-filing cite its own prior rejection.
      expect(got[0]!.content).toContain('REJECT')
    })

    it('does not recall a merely similar event — the 0.15 bound is tight on purpose', async () => {
      // A loose bound turns "we decided this before" into "we decided something
      // vaguely like this before", which is how a system cites irrelevant precedent.
      const got = await decisionMemory(db, { orgId: ORG, vec: VEC_FAR, dim: 768 })
      expect(got).toEqual([])
    })
  })

  describe('retrieveCandidates — all four sources unioned', () => {
    it('degrades rather than throwing when no embedding is available', async () => {
      const event = normalize(
        rawEvent({
          sourceRef: 'acme/api#999',
          title: 'Session crash on expired token',
          body: 'Stack trace points at `apps/api/src/session.ts`.',
        }),
      )

      const got = await retrieveCandidates(db, { orgId: ORG, event })

      // Without a vector, sources 1 and 4 cannot run. That is reported, not hidden:
      // less evidence lowers confidence, which routes the event to a human.
      expect(got.degraded).toContain('vector:no_embedding')
      expect(got.degraded).toContain('decision:no_embedding')
      expect(Array.isArray(got.candidates)).toBe(true)
    })

    it('unions vector, lexical and git hits into one ranked candidate set', async () => {
      const event = normalize(
        rawEvent({
          sourceRef: 'acme/api#1000',
          title: "TypeError: cannot read 'id' of undefined",
          body: 'Crashes in `apps/api/src/session.ts` after v2.3.1.',
        }),
      )

      const got = await retrieveCandidates(db, { orgId: ORG, event, vec: VEC_A, dim: 768 })

      expect(got.candidates.length).toBeGreaterThan(0)
      expect(got.degraded).not.toContain('vector')
      expect(got.degraded).not.toContain('lexical')
      expect(got.degraded).not.toContain('git')

      // Every candidate carries the fields the prompt builder and citation
      // validator both depend on.
      for (const c of got.candidates) {
        expect(c.ref).toBeTruthy()
        expect(c.entityId).toBeTruthy()
        expect(typeof c.score).toBe('number')
      }
      expect(got.tokens).toBeGreaterThan(0)
    })

    it('never returns the event being triaged as its own neighbour', async () => {
      const event = normalize(
        rawEvent({
          sourceRef: 'acme/api#1001',
          title: 'Self reference check',
          body: 'Touches `apps/api/src/session.ts`.',
        }),
      )
      const { row } = await insertEvent(db, event)
      await addEmbedding(db, {
        entityKind: 'event',
        entityId: row.id,
        content: 'Self reference check',
        vec768: VEC_A,
      })

      const got = await retrieveCandidates(db, {
        orgId: ORG,
        event: { ...event, id: row.id },
        vec: VEC_A,
        dim: 768,
      })
      expect(got.candidates.map((c) => c.entityId)).not.toContain(row.id)
    })
  })
})
