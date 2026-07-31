import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

/**
 * Retrieval source #1 (§9): vector neighbours, top-8 by cosine distance.
 *
 * Two vector columns on purpose. `vec768` is Gemini text-embedding-004; `vec384` is
 * the local bge-small-en fallback. Different models put different meanings in the
 * same coordinates, so a 768 distance and a 384 distance are not comparable — giving
 * them separate columns makes mixing them a type error instead of a silent
 * retrieval-quality regression.
 *
 * HNSW rather than IVFFlat: IVFFlat needs a training pass over existing rows to
 * build its lists, which is useless on a table that starts empty. HNSW indexes from
 * the first insert.
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),

    /** event | decision | ticket | commit | doc — polymorphic by design. */
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),

    /** Exactly the text that was embedded, so a re-embed is reproducible. */
    content: text('content').notNull(),
    /** Longer entities are chunked; ordinal keeps chunks orderable. */
    chunk: integer('chunk').notNull().default(0),

    model: text('model'),
    vec768: vector('vec768', { dimensions: 768 }),
    vec384: vector('vec384', { dimensions: 384 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('embeddings_entity_uq').on(t.orgId, t.entityKind, t.entityId, t.chunk),
    index('embeddings_vec768_hnsw').using('hnsw', t.vec768.op('vector_cosine_ops')),
    index('embeddings_vec384_hnsw').using('hnsw', t.vec384.op('vector_cosine_ops')),
    /** Retrieval source #2: lexical neighbours via ts_rank over the same corpus. */
    index('embeddings_fts_idx').using('gin', sql`to_tsvector('english', ${t.content})`),
  ],
)

export type EmbeddingRow = typeof embeddings.$inferSelect
export type NewEmbeddingRow = typeof embeddings.$inferInsert
