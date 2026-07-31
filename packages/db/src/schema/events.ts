import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { Extracted } from '@ascendant/core'
import { eventKindEnum, sourceEnum, trustEnum } from './enums'

/**
 * Every NormalizedEvent that ever entered the system, verbatim. Nothing is deleted:
 * the pipeline's replayability depends on the input rows still being here.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),

    source: sourceEnum('source').notNull(),
    /** Stable upstream id. Half of the webhook idempotency key. */
    sourceRef: text('source_ref').notNull(),
    kind: eventKindEnum('kind').notNull(),

    /**
     * `source:threadKey ?? sourceRef` — §7.3 thread collapsing. A 14-reply Slack
     * thread shares one unitKey and is therefore ONE unit of work, not 14.
     */
    unitKey: text('unit_key').notNull(),
    threadKey: text('thread_key'),

    actorId: text('actor_id').notNull(),
    actorHandle: text('actor_handle').notNull(),
    actorIsBot: boolean('actor_is_bot').notNull().default(false),

    title: text('title').notNull(),
    /** Quoted replies and signatures already stripped by normalize(). */
    body: text('body').notNull(),

    /** sha256 of canonicalized title+body. Powers the exact_dupe policy rule. */
    contentHash: text('content_hash').notNull(),
    extracted: jsonb('extracted').$type<Extracted>().notNull(),
    trust: trustEnum('trust').notNull(),
    /** §15.3 layer 1: prompt-guard hit. Caps confidence at 0.5 and forces ESCALATE. */
    injectionSuspected: boolean('injection_suspected').notNull().default(false),

    attachments: jsonb('attachments')
      .$type<{ name: string; url: string; mime: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Untouched provider payload, for replaying a parse() fix without re-ingesting. */
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Webhook redelivery must be a no-op, not a second triage run. */
    uniqueIndex('events_source_ref_uq').on(t.orgId, t.source, t.sourceRef),
    index('events_unit_key_idx').on(t.orgId, t.unitKey),
    index('events_content_hash_idx').on(t.orgId, t.contentHash),
    index('events_created_idx').on(t.orgId, t.createdAt),
  ],
)

export type EventRow = typeof events.$inferSelect
export type NewEventRow = typeof events.$inferInsert
