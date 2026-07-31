import type { RawEvent, SourceId } from '@ascendant/core'

/**
 * §7.1. Six sources, one interface. A connector is the only place in the codebase
 * that knows a provider's wire format; everything downstream speaks NormalizedEvent.
 *
 * verify() is separate from parse() on purpose: no handler may process a body it
 * has not authenticated (§15.2), and keeping them apart makes that ordering a
 * type-level obligation rather than a convention.
 */
export interface Connector {
  id: SourceId
  /** Signature check over the RAW body. Must be timing-safe. */
  verify(req: VerifiableRequest): Promise<boolean>
  /** One provider payload can yield n events (or zero, for ignored actions). */
  parse(raw: unknown, ctx: ParseContext): Promise<RawEvent[]>
  /** Optional: fetch thread parents or issue bodies the webhook omitted. */
  hydrate?(e: RawEvent): Promise<RawEvent>
  /** Optional: comment, close, react, reply. */
  respond?(action: OutboundAction): Promise<void>
}

/**
 * The minimum a connector needs from an HTTP request, so connectors stay testable
 * without constructing a Next.js Request. `body` is the exact bytes as text —
 * re-serializing parsed JSON would break every HMAC.
 */
export interface VerifiableRequest {
  headers: Headers
  body: string
}

export interface ParseContext {
  orgId: string
  /** Delivery/message id, for logging a payload back to its webhook attempt. */
  deliveryId?: string
}

export type OutboundAction =
  | { kind: 'comment'; target: string; body: string }
  | { kind: 'close'; target: string; reason?: string }
  | { kind: 'label'; target: string; labels: string[] }
  | { kind: 'react'; target: string; emoji: string }

/** Thrown by verify() when a request is malformed rather than merely unsigned. */
export class WebhookError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'WebhookError'
  }
}
