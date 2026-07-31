import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { artifactKindEnum } from './enums'
import { runs } from './runs'
import { tickets } from './tickets'

/**
 * Where every blob lives. Inngest caps event payloads at 256 KiB, step returns at
 * 4 MB and total run state at 32 MB, so diffs, test logs and debate transcripts are
 * written here and the workflow passes only this row's id. Content is stored as text
 * rather than in object storage: a 400-line diff is a few KB, and one fewer service
 * to configure is worth more than the theoretical ceiling.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),

    kind: artifactKindEnum('kind').notNull(),
    /** Debate round that produced it, so round 2's diff doesn't overwrite round 1's. */
    round: integer('round'),
    /** Producing agent, for the Run Detail view. */
    agent: text('agent'),

    content: text('content').notNull(),
    bytes: integer('bytes').notNull().default(0),
    /** e.g. files touched, added/removed line counts, exit code, blocked-path hits. */
    meta: jsonb('meta').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('artifacts_ticket_kind_idx').on(t.ticketId, t.kind, t.createdAt),
    index('artifacts_run_idx').on(t.runId),
  ],
)

export type ArtifactRow = typeof artifacts.$inferSelect
export type NewArtifactRow = typeof artifacts.$inferInsert
