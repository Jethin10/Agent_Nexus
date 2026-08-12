import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/** Durable, at-least-once delivery queue for external side effects. */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('outbox_dedupe_uq').on(t.orgId, t.dedupeKey),
    index('outbox_ready_idx').on(t.status, t.availableAt, t.createdAt),
    index('outbox_lease_idx').on(t.lockedUntil).where(sql`${t.status} = 'processing'`),
  ],
)

export type OutboxRow = typeof outbox.$inferSelect
