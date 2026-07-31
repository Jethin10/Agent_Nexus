import { createHash, randomUUID } from 'node:crypto'
import { NormalizedEvent, type RawEvent } from './event.js'
import { extract } from './extract.js'
import type { TrustLevel } from './ids.js'

/** Strip quoted replies and signatures so a 5-deep email thread hashes stably. */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*On\s+.{4,80}\s+wrote:\s*$/.test(line)) break
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line)) break
    if (/^\s*--\s*$/.test(line)) break // signature delimiter
    if (/^\s*>/.test(line)) continue // quoted line
    out.push(line)
  }
  return out.join('\n').trim()
}

/** Collapse runs of whitespace so cosmetic edits don't produce a new event. */
function canonical(title: string, body: string): string {
  return `${title.trim()}\n\n${body.trim()}`.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
}

export function contentHash(title: string, body: string): string {
  return createHash('sha256').update(canonical(title, body), 'utf8').digest('hex')
}

export interface TrustInput {
  actorHandle: string
  /** Handles/domains treated as internal — from the `config` table, not hardcoded. */
  internalActors?: readonly string[]
  /** e.g. prior contributors, paying customers. */
  knownExternalActors?: readonly string[]
}

export function deriveTrust(input: TrustInput): TrustLevel {
  const h = input.actorHandle.toLowerCase()
  const has = (xs?: readonly string[]) => (xs ?? []).some((x) => x.toLowerCase() === h)
  if (has(input.internalActors)) return 'internal'
  if (has(input.knownExternalActors)) return 'known_external'
  return 'anonymous'
}

/**
 * Thread collapsing (§7.3): a 14-reply Slack thread is ONE unit of work keyed by
 * threadKey, not 14 events. Without this the cost model breaks — 14 events at
 * ~25 LLM calls each would consume a third of the daily Groq ceiling on one
 * conversation. Callers upsert on (source, threadKey) when threadKey is set.
 */
export function unitKey(e: Pick<RawEvent, 'source' | 'sourceRef' | 'threadKey'>): string {
  return `${e.source}:${e.threadKey ?? e.sourceRef}`
}

export interface NormalizeOptions extends Omit<TrustInput, 'actorHandle'> {
  injectionSuspected?: boolean
  id?: string
}

/**
 * RawEvent -> NormalizedEvent. Pure: no I/O, no LLM, fully deterministic given
 * its inputs, which is what makes the whole pipeline replayable from stored rows.
 */
export function normalize(raw: RawEvent, opts: NormalizeOptions = {}): NormalizedEvent {
  const body = stripQuoted(raw.body)
  const title = raw.title.trim()
  return NormalizedEvent.parse({
    ...raw,
    id: opts.id ?? randomUUID(),
    title,
    body,
    contentHash: contentHash(title, body),
    extracted: extract(title, body),
    trust: deriveTrust({
      actorHandle: raw.actor.handle,
      internalActors: opts.internalActors,
      knownExternalActors: opts.knownExternalActors,
    }),
    injectionSuspected: opts.injectionSuspected ?? false,
  })
}
