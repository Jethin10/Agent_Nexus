import { z } from 'zod'
import { EventKind, OrgId, SourceId, TrustLevel } from './ids.js'

/**
 * What a connector's parse() emits: upstream shape, not yet enriched.
 * hydrate() may fill in thread parents before normalization.
 */
export const RawEvent = z.object({
  orgId: OrgId,
  source: SourceId,
  sourceRef: z.string().min(1), // stable upstream id — half of the idempotency key
  kind: EventKind,
  threadKey: z.string().nullable(),
  actor: z.object({
    id: z.string(),
    handle: z.string(),
    isBot: z.boolean(),
  }),
  title: z.string(),
  body: z.string(),
  createdAt: z.coerce.date(),
  attachments: z
    .array(z.object({ name: z.string(), url: z.string(), mime: z.string() }))
    .default([]),
  raw: z.unknown(),
})
export type RawEvent = z.infer<typeof RawEvent>

/**
 * Deterministic, regex-derived. No LLM touches this.
 * These are the join keys for lexical retrieval and git-activity overlap (§9),
 * which is exactly why they must not be model-generated: a regex is free,
 * instant, and better than a model at exact string capture.
 */
export const Extracted = z.object({
  symbols: z.array(z.string()), // identifiers, file paths, function names
  versions: z.array(z.string()), // v2.3.1, commit shas
  stackFrames: z.array(z.string()),
  urls: z.array(z.string()),
  issueRefs: z.array(z.string()), // #412, ENG-88
})
export type Extracted = z.infer<typeof Extracted>

/** Six sources, one internal shape. Everything downstream speaks only this. */
export const NormalizedEvent = RawEvent.extend({
  id: z.string().uuid(),
  /** sha256 of normalized title+body — the other half of the idempotency key. */
  contentHash: z.string().length(64),
  extracted: Extracted,
  trust: TrustLevel,
  /** Layer 1 of §15.3: set by prompt-guard, caps confidence at 0.5 and forces ESCALATE. */
  injectionSuspected: z.boolean().default(false),
})
export type NormalizedEvent = z.infer<typeof NormalizedEvent>
