import { EventSchemas, Inngest } from 'inngest'
import { z } from 'zod'

/**
 * §4.3 — five functions, not one, split on the natural wait points. That keeps any
 * single run's state well under Inngest's 32 MB ceiling and lets a stalled ticket
 * sit in a DEFER wait without holding one of the five concurrency slots.
 *
 * **Every payload here carries ids only.** Inngest's free event payload cap is
 * 256 KiB and step returns cap at 4 MB, so diffs, transcripts and file contents go
 * to `artifacts` and are referenced by id (R2). This is the single rule that makes a
 * large real ticket behave like a small seeded one, so the schemas are deliberately
 * narrow: there is nowhere to put a blob even by accident.
 */
export const eventSchemas = new EventSchemas().fromZod({
  'event/received': {
    data: z.object({
      orgId: z.string(),
      eventId: z.string().uuid(),
      source: z.string(),
      sourceRef: z.string(),
    }),
  },
  'triage/requested': {
    data: z.object({
      orgId: z.string(),
      eventId: z.string().uuid(),
    }),
  },
  'work/accepted': {
    data: z.object({
      orgId: z.string(),
      ticketId: z.string().uuid(),
      decisionId: z.string().uuid(),
    }),
  },
  'review/ready': {
    data: z.object({
      orgId: z.string(),
      ticketId: z.string().uuid(),
      /** Artifact id of the diff — never the diff itself. */
      diffArtifactId: z.string().uuid(),
      round: z.number().int().min(1),
    }),
  },
  'delivery/ready': {
    data: z.object({
      orgId: z.string(),
      ticketId: z.string().uuid(),
      diffArtifactId: z.string().uuid(),
      testLogArtifactId: z.string().uuid().optional(),
    }),
  },
  /**
   * Human decisions that unblock a `waitForEvent`. §8.3: a Slack button click emits
   * one of these, which is how a DEFER or ESCALATE is resolved without anyone
   * opening the dashboard.
   */
  'human/resolved': {
    data: z.object({
      orgId: z.string(),
      eventId: z.string().uuid(),
      decisionId: z.string().uuid(),
      outcome: z.enum(['ACCEPT', 'REJECT', 'MERGE', 'DEFER', 'ESCALATE']),
      actor: z.string(),
      reason: z.string().optional(),
    }),
  },
  /** The filer answered a DEFER's questions, so the event can be re-triaged. */
  'human/replied': {
    data: z.object({
      orgId: z.string(),
      eventId: z.string().uuid(),
      newEventId: z.string().uuid().optional(),
    }),
  },
  'maintenance/daily': { data: z.object({ orgId: z.string().optional() }) },
})

export type AscendantEvents = typeof eventSchemas

/**
 * One client, shared by all five functions and by the webhook handlers that seed
 * the pipeline with `event/received`.
 *
 * The signing key is verified by the SDK itself (§15.2) — Inngest is the one
 * webhook source this codebase does not hand-verify, because its own middleware
 * does it before a function body ever runs.
 */
export const inngest = new Inngest({
  id: 'ascendant',
  schemas: eventSchemas,
  ...(process.env.INNGEST_EVENT_KEY ? { eventKey: process.env.INNGEST_EVENT_KEY } : {}),
})
