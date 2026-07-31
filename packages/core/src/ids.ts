import { z } from 'zod'

/** Every table carries org_id and every query filters on it (§15.4). */
export const OrgId = z.string().min(1).max(64)
export type OrgId = z.infer<typeof OrgId>

export const SourceId = z.enum([
  'github',
  'linear',
  'slack',
  'gmail',
  'gcal',
  'gdrive',
  'granola',
])
export type SourceId = z.infer<typeof SourceId>

export const EventKind = z.enum([
  'issue',
  'pr',
  'comment',
  'message',
  'email',
  'meeting_note',
  'doc',
  'command',
])
export type EventKind = z.infer<typeof EventKind>

/** Drives the autonomy ceiling in §15.3: anonymous never gets an autonomous close. */
export const TrustLevel = z.enum(['internal', 'known_external', 'anonymous'])
export type TrustLevel = z.infer<typeof TrustLevel>
