import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { outcomeEnum } from './enums'
import { decisions } from './decisions'

/**
 * A human disagreed with an autonomous decision and changed it. This is the
 * numerator of the one number the project reports:
 *
 *   triage precision = 1 - (overturns / autonomous_decisions)
 *
 * Stored per-outcome-pair rather than as a boolean because the confusion matrix
 * matters more than the scalar: a REJECT that should have been ACCEPT (work silently
 * dropped) is a far worse failure than an ACCEPT that should have been REJECT
 * (wasted tokens, human notices the PR).
 */
export const overturns = pgTable(
  'overturns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decisions.id, { onDelete: 'cascade' }),

    fromOutcome: outcomeEnum('from_outcome').notNull(),
    toOutcome: outcomeEnum('to_outcome').notNull(),

    /** Who overturned it — handle, or 'eval' for hand-labelled eval-set rows. */
    actor: text('actor').notNull(),
    /** Why the gate was wrong. This text is the highest-value training signal here. */
    reason: text('reason'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('overturns_decision_idx').on(t.decisionId),
    index('overturns_matrix_idx').on(t.orgId, t.fromOutcome, t.toOutcome),
  ],
)

export type OverturnRow = typeof overturns.$inferSelect
export type NewOverturnRow = typeof overturns.$inferInsert
