import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { runs } from './runs'
import { tickets } from './tickets'

/**
 * The project's own observability spine. Inngest free retains traces for 24 hours
 * and Vercel Hobby logs for 1 hour, so anything the Run Detail view needs after a
 * demo has to live here. This table is also what DEMO_MODE=replay reads back, at
 * the original timings, when the network is hostile (§16.3).
 */
export const agentEvents = pgTable(
  'agent_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),

    /** orchestrator | triage | research | planner | coder | reviewer | qa | delivery */
    agent: text('agent').notNull(),
    /** proposed | critiqued | revised | ran_tests | decided | blocked | ... */
    phase: text('phase').notNull(),
    /** Debate round, 1-3. Null for single-shot agents. */
    round: integer('round'),

    /** Short human-readable line — this is what renders in the timeline thread. */
    summary: text('summary').notNull(),
    /**
     * Structured payload. Never a blob: diffs, transcripts and file contents go to
     * `artifacts` and are referenced by id from here (§4 — no blobs through events).
     */
    detail: jsonb('detail').$type<Record<string, unknown>>(),

    model: text('model'),
    tokens: integer('tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),

    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_events_ticket_idx').on(t.ticketId, t.at),
    index('agent_events_run_idx').on(t.runId, t.at),
  ],
)

export type AgentEventRow = typeof agentEvents.$inferSelect
export type NewAgentEventRow = typeof agentEvents.$inferInsert
