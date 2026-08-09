import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { ticketStatusEnum } from './enums'
import { decisions } from './decisions'
import { events } from './events'

/**
 * A unit of accepted work. Created ONLY by an ACCEPT decision — the gate is the
 * only door into the work pipeline, so there is no path from event to code that
 * skips triage. Mirrors a Linear issue but is authoritative locally: the pipeline
 * must keep running when the Linear API is down.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),

    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'restrict' }),

    title: text('title').notNull(),
    /** Restated problem statement, not the raw body — the Planner reads this. */
    statement: text('statement').notNull(),
    status: ticketStatusEnum('status').notNull().default('planning'),

    /** Linear identity, null until the Delivery agent has pushed it upstream. */
    linearId: text('linear_id'),
    linearIdentifier: text('linear_identifier'),

    /**
     * Slack message timestamp, which is also its id. §8.3 updates one threaded message
     * in place via `chat.update` rather than posting per stage, so this is what makes
     * the second notification an edit instead of a new line in the channel.
     */
    slackChannel: text('slack_channel'),
    slackTs: text('slack_ts'),

    /** Branch is always ascendant/<linear-id>-<slug>; never main (§8.1). */
    branch: text('branch'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    /** Draft when confidence < 0.80. Never auto-merged, at any confidence. */
    prIsDraft: boolean('pr_is_draft').notNull().default(true),

    /** Running totals against the §10.4 per-ticket ceilings. */
    tokensUsed: integer('tokens_used').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),

    labels: jsonb('labels')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    /** One ticket per accepted event — a redelivered webhook cannot fork the work. */
    uniqueIndex('tickets_event_uq').on(t.eventId),
    index('tickets_status_idx').on(t.orgId, t.status, t.updatedAt),
  ],
)

export type TicketRow = typeof tickets.$inferSelect
export type NewTicketRow = typeof tickets.$inferInsert
