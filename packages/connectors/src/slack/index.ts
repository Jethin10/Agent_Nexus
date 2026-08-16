import type { RawEvent } from '@ascendant/core'
import { WebhookError } from '../types.js'

/**
 * The write side of Slack: one threaded message per ticket, updated in place (§8.3).
 *
 * `chat.update` rather than a new message per stage, because the alternative is a
 * channel where one ticket produces six notifications and people mute it. The ticket's
 * message timestamp is the update key, stored on the ticket row.
 *
 * Slack's failure mode is the trap here: the API answers **HTTP 200 with `ok: false`**
 * for almost everything that goes wrong — a bad token, a channel the bot was never
 * invited to, a stale timestamp. Checking `res.ok` alone reports success while nothing
 * is posted, so every call parses the body and reads `ok`.
 */
const API = 'https://slack.com/api'

/** Slack's own retry hint on a 429, in seconds. */
const DEFAULT_RETRY_AFTER = 30

export interface SlackHistoryOptions {
  token: string
  channel: string
  maxMessages?: number
  fetcher?: typeof fetch
}

export interface SlackInboundMessage {
  channel: string
  ts: string
  threadTs?: string
  user?: string
  text: string
  botId?: string
  subtype?: string
}

/** Read a bounded channel history for the operator-triggered context sync. */
export function slackHistoryReader(opts: SlackHistoryOptions) {
  const fetcher = opts.fetcher ?? fetch
  const call = async <T>(method: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${API}/${method}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const res = await fetcher(url, { headers: { authorization: `Bearer ${opts.token}` } })
    const body = await res.json() as T & { ok?: boolean; error?: string }
    if (!res.ok || !body.ok) throw new SlackError(`slack ${method} refused: ${body.error ?? `HTTP ${res.status}`}`, body.error)
    return body
  }

  return {
    async read(orgId: string): Promise<RawEvent[]> {
      const limit = String(Math.min(Math.max(opts.maxMessages ?? 40, 1), 100))
      const history = await call<{ ok?: boolean; messages?: SlackApiMessage[] }>('conversations.history', {
        channel: opts.channel,
        limit,
      })
      const events: RawEvent[] = []
      for (const message of history.messages ?? []) {
        const raw = slackMessageToRaw(toInbound(opts.channel, message), orgId)
        if (raw) events.push(raw)
        if (message.reply_count && Number(message.reply_count) > 0 && message.ts) {
          const replies = await call<{ ok?: boolean; messages?: SlackApiMessage[] }>('conversations.replies', {
            channel: opts.channel,
            ts: message.ts,
            limit: '100',
          })
          for (const reply of (replies.messages ?? []).slice(1)) {
            const parsed = slackMessageToRaw(toInbound(opts.channel, reply), orgId)
            if (parsed) events.push(parsed)
          }
        }
      }
      return events
    },
  }
}

interface SlackApiMessage {
  ts?: string
  thread_ts?: string
  user?: string
  text?: string
  bot_id?: string
  subtype?: string
  reply_count?: number
}

function toInbound(channel: string, message: SlackApiMessage): SlackInboundMessage {
  return {
    channel,
    ts: message.ts ?? '',
    ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
    ...(message.user ? { user: message.user } : {}),
    text: message.text ?? '',
    ...(message.bot_id ? { botId: message.bot_id } : {}),
    ...(message.subtype ? { subtype: message.subtype } : {}),
  }
}

export function slackMessageToRaw(message: SlackInboundMessage, orgId: string): RawEvent | undefined {
  if (!message.ts || !message.channel || !message.text.trim()) return undefined
  // Never ingest the bot's own delivery updates back into the gate.
  if (message.botId || (message.subtype && message.subtype !== 'thread_broadcast')) return undefined
  const thread = message.threadTs || message.ts
  const firstLine = message.text.split(/\r?\n/, 1)[0]?.trim() || 'Slack conversation'
  return {
    orgId,
    source: 'slack',
    sourceRef: `slack:${message.channel}:${message.ts}`,
    kind: 'message',
    threadKey: `slack:${message.channel}:${thread}`,
    actor: { id: message.user ?? 'unknown', handle: message.user ?? 'unknown', isBot: false },
    title: firstLine.slice(0, 160),
    body: message.text,
    createdAt: new Date(Number(message.ts.split('.')[0]) * 1_000),
    attachments: [],
    raw: message,
  }
}

export class SlackError extends Error {
  constructor(
    message: string,
    /** Slack's machine-readable code: `invalid_auth`, `channel_not_found`, … */
    readonly code?: string,
    /** Set on a 429, so the caller can decide between waiting and giving up. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'SlackError'
  }
}

export interface SlackWriterOptions {
  /** Bot token, `xoxb-…`. Minted per workspace, never committed. */
  token: string
  /** Channel id (`C…`) — not a `#name`, which Slack no longer resolves on post. */
  channel: string
  fetcher?: typeof fetch
}

/** What a caller needs to update the message later. */
export interface SlackMessage {
  channel: string
  /** Slack's message timestamp, which doubles as its id. */
  ts: string
}

export interface SlackButton {
  /** The text on the button. */
  text: string
  /**
   * Returned verbatim in the interaction payload. §4.3: a click emits the event a
   * `waitForEvent` is blocked on, which is how a human unblocks a DEFER without
   * opening the dashboard — so this has to carry enough to identify the decision.
   */
  actionId: string
  value: string
  style?: 'primary' | 'danger'
}

export interface SlackWriter {
  post(text: string, buttons?: readonly SlackButton[]): Promise<SlackMessage>
  update(ts: string, text: string, buttons?: readonly SlackButton[]): Promise<SlackMessage>
  /** A reply in the message's thread, for stage updates that deserve their own line. */
  reply(threadTs: string, text: string): Promise<SlackMessage>
}

/**
 * Blocks rather than a bare `text`, because buttons require them. `text` is still sent
 * as the notification fallback — without it the push notification is empty.
 */
function blocks(text: string, buttons: readonly SlackButton[] = []): unknown[] {
  const out: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text } }]
  if (buttons.length > 0) {
    out.push({
      type: 'actions',
      elements: buttons.map((b) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.text, emoji: false },
        action_id: b.actionId,
        value: b.value,
        ...(b.style ? { style: b.style } : {}),
      })),
    })
  }
  return out
}

export function slackWriter(opts: SlackWriterOptions): SlackWriter {
  const fetcher = opts.fetcher ?? fetch

  const call = async (method: string, payload: Record<string, unknown>): Promise<SlackMessage> => {
    const res = await fetcher(`${API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    })

    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER
      throw new SlackError(`slack rate limited, retry after ${retry}s`, 'ratelimited', retry)
    }
    if (!res.ok) {
      throw new SlackError(`slack ${method}: HTTP ${res.status}`)
    }

    // The important line. Slack returns 200 for `invalid_auth` and `channel_not_found`
    // alike, so the body is the only place failure is actually reported.
    const body = (await res.json()) as { ok?: boolean; error?: string; ts?: string; channel?: string }
    if (!body.ok) {
      throw new SlackError(`slack ${method} refused: ${body.error ?? 'unknown'}`, body.error)
    }
    if (!body.ts) {
      throw new SlackError(`slack ${method} returned no message timestamp`, 'no_ts')
    }
    return { channel: body.channel ?? opts.channel, ts: body.ts }
  }

  return {
    async post(text, buttons) {
      return call('chat.postMessage', {
        channel: opts.channel,
        text,
        blocks: blocks(text, buttons),
      })
    },

    async update(ts, text, buttons) {
      return call('chat.update', {
        channel: opts.channel,
        ts,
        text,
        blocks: blocks(text, buttons),
      })
    },

    async reply(threadTs, text) {
      return call('chat.postMessage', {
        channel: opts.channel,
        thread_ts: threadTs,
        text,
        blocks: blocks(text),
      })
    },
  }
}

/**
 * Slack signs with a versioned basestring rather than the raw body alone, and rejects
 * anything older than five minutes so a captured request cannot be replayed (§15.2).
 *
 * Timing-safe comparison is the caller's job — `safeEqualHex` in `verify.ts` — because
 * this function only assembles the string that gets signed.
 */
export function slackBasestring(timestamp: string, body: string): string {
  return `v0:${timestamp}:${body}`
}

/** Slack's own tolerance, from its docs: reject anything older than five minutes. */
export const SLACK_MAX_SKEW_SECONDS = 300

export function slackTimestampFresh(
  timestamp: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  // Absolute difference: a timestamp far in the *future* is as suspect as a stale one,
  // and clock skew cuts both ways.
  return Math.abs(nowSeconds - ts) <= SLACK_MAX_SKEW_SECONDS
}

/** Raised when an inbound Slack request is malformed rather than merely unsigned. */
export function slackWebhookError(message: string): WebhookError {
  return new WebhookError(message, 400)
}
