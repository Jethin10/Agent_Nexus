import { Buffer } from 'node:buffer'
import type { RawEvent } from '@ascendant/core'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

export interface GmailReaderOptions {
  clientId: string
  clientSecret: string
  refreshToken: string
  query?: string
  maxMessages?: number
  fetcher?: typeof fetch
}

interface GmailHeader { name?: string; value?: string }
interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string }
  headers?: GmailHeader[]
  parts?: GmailPart[]
}
interface GmailMessage {
  id?: string
  threadId?: string
  internalDate?: string
  payload?: GmailPart
  snippet?: string
}

/** Read-only Gmail poller used by the operator-triggered context sync. */
export function gmailReader(opts: GmailReaderOptions) {
  const fetcher = opts.fetcher ?? fetch

  async function accessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await fetcher(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const json = await res.json() as { access_token?: string; error?: string; error_description?: string }
    if (!res.ok || !json.access_token) {
      throw new Error(`gmail oauth failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`)
    }
    return json.access_token
  }

  async function api<T>(token: string, path: string): Promise<T> {
    const res = await fetcher(`${GMAIL_API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const json = await res.json() as T & { error?: { message?: string } }
    if (!res.ok) throw new Error(`gmail API failed: ${json.error?.message ?? `HTTP ${res.status}`}`)
    return json
  }

  return {
    async read(orgId: string): Promise<RawEvent[]> {
      const token = await accessToken()
      const query = opts.query?.trim() || 'label:ascendant newer_than:30d'
      const max = Math.min(Math.max(opts.maxMessages ?? 25, 1), 100)
      const listed = await api<{ messages?: { id?: string }[] }>(
        token,
        `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
      )
      const messages = await Promise.all(
        (listed.messages ?? []).flatMap((item) => item.id
          ? [api<GmailMessage>(token, `/users/me/messages/${encodeURIComponent(item.id)}?format=full`)]
          : []),
      )
      return messages.flatMap((message) => {
        const parsed = gmailMessageToRaw(message, orgId)
        return parsed ? [parsed] : []
      })
    },
  }
}

export function gmailMessageToRaw(message: GmailMessage, orgId: string): RawEvent | undefined {
  if (!message.id || !message.threadId) return undefined
  const headers = new Map(
    (message.payload?.headers ?? []).map((header) => [header.name?.toLowerCase() ?? '', header.value ?? '']),
  )
  const from = headers.get('from') || 'unknown'
  const actor = parseMailbox(from)
  const subject = headers.get('subject')?.trim() || '(no subject)'
  const body = textBody(message.payload) || message.snippet || ''
  const createdAt = message.internalDate && Number.isFinite(Number(message.internalDate))
    ? new Date(Number(message.internalDate))
    : new Date()

  return {
    orgId,
    source: 'gmail',
    sourceRef: `gmail:${message.id}`,
    kind: 'email',
    threadKey: `gmail:${message.threadId}`,
    actor: { id: actor.address, handle: actor.handle, isBot: false },
    title: subject,
    body,
    createdAt,
    attachments: attachments(message.payload),
    raw: message,
  }
}

function parseMailbox(value: string): { address: string; handle: string } {
  const address = /<([^>]+)>/.exec(value)?.[1] ?? value.trim()
  const display = value.replace(/<[^>]+>/, '').replace(/^"|"$/g, '').trim()
  return { address, handle: display || address }
}

function decode(data: string | undefined): string {
  if (!data) return ''
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function textBody(part: GmailPart | undefined): string {
  if (!part) return ''
  if (part.mimeType === 'text/plain') return decode(part.body?.data).trim()
  for (const child of part.parts ?? []) {
    const text = textBody(child)
    if (text) return text
  }
  if (!part.parts?.length && part.body?.data) return decode(part.body.data).trim()
  return ''
}

function attachments(part: GmailPart | undefined): { name: string; url: string; mime: string }[] {
  if (!part) return []
  const own = part.filename && part.body?.attachmentId
    ? [{
        name: part.filename,
        url: `gmail-attachment:${part.body.attachmentId}`,
        mime: part.mimeType || 'application/octet-stream',
      }]
    : []
  return [...own, ...(part.parts ?? []).flatMap(attachments)]
}
