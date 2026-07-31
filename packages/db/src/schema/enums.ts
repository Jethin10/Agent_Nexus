import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Enum values are kept byte-identical to the Zod enums in @ascendant/core so a
 * NormalizedEvent can be inserted without a translation layer. If you change one,
 * change both — the typecheck won't catch a drifted string literal.
 */
export const sourceEnum = pgEnum('source', [
  'github',
  'linear',
  'slack',
  'gmail',
  'gcal',
  'gdrive',
  'granola',
])

export const eventKindEnum = pgEnum('event_kind', [
  'issue',
  'pr',
  'comment',
  'message',
  'email',
  'meeting_note',
  'doc',
  'command',
])

export const trustEnum = pgEnum('trust_level', ['internal', 'known_external', 'anonymous'])

/** The five triage outcomes. Four of them are refusals — that is the product. */
export const outcomeEnum = pgEnum('triage_outcome', [
  'ACCEPT',
  'REJECT',
  'MERGE',
  'DEFER',
  'ESCALATE',
])

export const ticketStatusEnum = pgEnum('ticket_status', [
  'planning',
  'coding',
  'reviewing',
  'qa',
  'delivering',
  'done',
  'blocked',
  'abandoned',
])

export const runStatusEnum = pgEnum('run_status', [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'waiting',
])

export const artifactKindEnum = pgEnum('artifact_kind', [
  'plan',
  'diff',
  'review',
  'test_log',
  'transcript',
  'pr_body',
  'file_snapshot',
])
