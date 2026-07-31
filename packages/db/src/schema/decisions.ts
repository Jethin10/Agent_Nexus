import { sql } from 'drizzle-orm'
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { Citation } from '@ascendant/core'
import { outcomeEnum } from './enums'
import { events } from './events'

/**
 * The Triage Gate's output, immutable once written. This table IS the thesis:
 * four of the five outcomes are refusals, and every row carries the reasoning and
 * citations that justified it. It is also retrieval source #4 (§9) — a re-filed
 * issue is judged against prior decisions and cites its own earlier rejection.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    outcome: outcomeEnum('outcome').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    reasoning: text('reasoning').notNull(),
    citations: jsonb('citations').$type<Citation[]>().notNull(),

    /** Set when outcome = MERGE: the event/ticket this duplicates. */
    mergeTargetId: text('merge_target_id'),
    /** Set when outcome = DEFER: the specific questions to ask. */
    missingInfo: jsonb('missing_info')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Deterministic rules that fired pre-LLM (§5.3). Feeds policy_agreement. */
    policyHits: jsonb('policy_hits')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** §5.4 confidence components, stored so calibration is auditable after the fact. */
    modelSelfReport: doublePrecision('model_self_report'),
    evidenceStrength: doublePrecision('evidence_strength'),
    policyAgreement: doublePrecision('policy_agreement'),

    /**
     * false when confidence < CONFIDENCE.AUTONOMOUS, or when trust/injection rules
     * forced a human in the loop. The denominator of triage precision
     * (1 - overturns/autonomous_decisions) counts only rows where this is true.
     */
    autonomous: boolean('autonomous').notNull().default(false),
    /** confidence in the 0.55-0.79 band: acted on, but surfaced for review. */
    needsReview: boolean('needs_review').notNull().default(false),

    modelUsed: text('model_used').notNull(),
    tokens: integer('tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('decisions_event_idx').on(t.eventId),
    index('decisions_outcome_idx').on(t.orgId, t.outcome, t.createdAt),
  ],
)

export type DecisionRow = typeof decisions.$inferSelect
export type NewDecisionRow = typeof decisions.$inferInsert
