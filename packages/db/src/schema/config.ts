import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Live-tunable policy. The autonomy thresholds, the internal-actor lists and the
 * token ceilings live here rather than in code for one concrete reason: the demo
 * drags the autonomy threshold from 0.80 to 0.95 in the Policy view and re-runs the
 * same issue to show the decision hold but the routing change. That is not possible
 * if the number is a constant behind a deploy.
 *
 * CONFIDENCE and LIMITS in @ascendant/core are the defaults; a row here overrides.
 */
export const config = pgTable(
  'config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),

    /** e.g. confidence.autonomous, actors.internal, budget.ticketTokens */
    key: text('key').notNull(),
    value: jsonb('value').notNull(),

    /** Why this was changed, so a surprising threshold has an explanation attached. */
    note: text('note'),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('config_org_key_uq').on(t.orgId, t.key)],
)

export type ConfigRow = typeof config.$inferSelect
export type NewConfigRow = typeof config.$inferInsert
