import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { runStatusEnum } from './enums'
import { tickets } from './tickets'

/**
 * One execution of one Inngest function. Keyed by runId so a retry attaches to the
 * same row rather than creating a phantom second run.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),

    /** Inngest function slug: ingest | triage | plan-and-code | qa | deliver. */
    fn: text('fn').notNull(),
    /** Inngest's own run id, so a trace in their UI maps to a row here. */
    inngestRunId: text('inngest_run_id'),
    status: runStatusEnum('status').notNull().default('running'),

    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),

    tokensUsed: integer('tokens_used').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('runs_ticket_idx').on(t.ticketId, t.startedAt),
    index('runs_inngest_idx').on(t.inngestRunId),
  ],
)

export type RunRow = typeof runs.$inferSelect
export type NewRunRow = typeof runs.$inferInsert
