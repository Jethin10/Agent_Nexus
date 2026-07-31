import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { decisions } from './decisions'
import { tickets } from './tickets'

/**
 * What actually happened downstream of a decision — did the PR merge, did the issue
 * get reopened, did a human close it as invalid after all. The learning loop reads
 * this; without it "the system improves over time" is a claim with no evidence
 * behind it.
 */
export const outcomes = pgTable(
  'outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),

    /** pr_merged | pr_closed | issue_reopened | ticket_abandoned | human_confirmed */
    kind: text('kind').notNull(),
    /** Did the decision hold up? Null while still unknown. */
    correct: boolean('correct'),

    /** Review cycles, test runs, retries — the cost side of the ledger. */
    reviewCycles: integer('review_cycles').notNull().default(0),
    tokensTotal: integer('tokens_total').notNull().default(0),
    /** Wall clock from ingest to delivery. */
    durationMs: integer('duration_ms'),

    note: text('note'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),

    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outcomes_decision_idx').on(t.decisionId),
    index('outcomes_kind_idx').on(t.orgId, t.kind, t.observedAt),
  ],
)

export type OutcomeRow = typeof outcomes.$inferSelect
export type NewOutcomeRow = typeof outcomes.$inferInsert
