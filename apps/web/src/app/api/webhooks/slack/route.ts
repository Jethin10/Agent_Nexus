import { applyHumanReview, getDecision, getEvent, db } from '@ascendant/db'
import {
  hmacHex,
  safeEqualHex,
  slackBasestring,
  slackMessageToRaw,
  slackTimestampFresh,
} from '@ascendant/connectors'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'
import { slackReviewerAllowed } from '@/lib/slack-auth'
import { persistContextEvents } from '@/lib/context-ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Slack interactive buttons → the same human/resolved event the dashboard emits. */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) return json({ error: 'SLACK_SIGNING_SECRET is not configured' }, 503)

  const body = await req.text()
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''
  if (!slackTimestampFresh(timestamp)) return json({ error: 'stale Slack request' }, 401)

  const expected = `v0=${hmacHex('sha256', secret, slackBasestring(timestamp, body))}`
  if (!safeEqualHex(signature.replace(/^v0=/, ''), expected.replace(/^v0=/, ''))) {
    return json({ error: 'signature verification failed' }, 401)
  }

  if (req.headers.get('content-type')?.includes('application/json')) {
    return handleSlackEvent(body)
  }

  const encoded = new URLSearchParams(body).get('payload')
  if (!encoded) return json({ error: 'missing Slack payload' }, 400)

  let payload: SlackInteraction
  try {
    payload = JSON.parse(encoded) as SlackInteraction
  } catch {
    return json({ error: 'Slack payload is not JSON' }, 400)
  }

  const slackUserId = payload.user?.id
  if (!slackReviewerAllowed(slackUserId, process.env.SLACK_REVIEWER_IDS)) {
    return json({ error: 'Slack user is not authorized to resolve Ascendant decisions' }, 403)
  }

  const action = payload.actions?.[0]
  const outcome = outcomeForAction(action?.action_id)
  const decisionId = action?.value
  if (!outcome || !decisionId) return json({ error: 'unsupported Slack action' }, 422)

  await ensureDb()
  const orgId = currentOrgId()
  const database = db()
  const decision = await getDecision(database, orgId, decisionId)
  if (!decision) return json({ error: 'decision not found' }, 404)
  const event = await getEvent(database, orgId, decision.eventId)
  if (!event) return json({ error: 'event not found' }, 404)

  const actor = payload.user?.username || payload.user?.name || payload.user?.id || 'slack-reviewer'
  const reason = `Resolved from Slack using ${action.action_id}.`
  const result = await applyHumanReview(database, {
    orgId,
    eventId: event.id,
    decisionId,
    outcome,
    actor,
    reason,
    surface: 'slack',
  })

  return json({
    response_type: 'ephemeral',
    replace_original: false,
    text: result.status === 'already_reviewed'
      ? `Ascendant already recorded this event as ${result.outcome}.`
      : `Ascendant recorded ${result.outcome} from @${actor} and queued durable workflow continuation.`,
  }, 200)
}

async function handleSlackEvent(body: string): Promise<Response> {
  let payload: SlackEventEnvelope
  try {
    payload = JSON.parse(body) as SlackEventEnvelope
  } catch {
    return json({ error: 'Slack event payload is not JSON' }, 400)
  }

  if (payload.type === 'url_verification' && payload.challenge) {
    return json({ challenge: payload.challenge }, 200)
  }
  if (payload.type !== 'event_callback' || payload.event?.type !== 'message') {
    return json({ ok: true, ignored: true }, 200)
  }

  const event = payload.event
  const allowed = new Set(
    (process.env.SLACK_INGEST_CHANNEL_IDS || process.env.SLACK_INGEST_CHANNEL_ID || process.env.SLACK_CHANNEL_ID || '')
      .split(',').map((channel) => channel.trim()).filter(Boolean),
  )
  if (allowed.size === 0) return json({ error: 'no Slack ingest channel is configured' }, 503)
  if (!event.channel || !allowed.has(event.channel)) return json({ ok: true, ignored: true, reason: 'channel' }, 200)

  const raw = slackMessageToRaw({
    channel: event.channel,
    ts: event.ts ?? '',
    ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
    ...(event.user ? { user: event.user } : {}),
    text: event.text ?? '',
    ...(event.bot_id ? { botId: event.bot_id } : {}),
    ...(event.subtype ? { subtype: event.subtype } : {}),
  }, currentOrgId())
  if (!raw) return json({ ok: true, ignored: true, reason: 'message' }, 200)

  const saved = await persistContextEvents([raw])
  return json({ ok: true, event: raw.sourceRef, ...saved }, 202)
}

interface SlackInteraction {
  user?: { id?: string; username?: string; name?: string }
  actions?: { action_id?: string; value?: string }[]
}

interface SlackEventEnvelope {
  type?: string
  challenge?: string
  event?: {
    type?: string
    channel?: string
    ts?: string
    thread_ts?: string
    user?: string
    text?: string
    bot_id?: string
    subtype?: string
  }
}

function outcomeForAction(id: string | undefined) {
  if (id === 'ascendant_approve') return 'ACCEPT' as const
  if (id === 'ascendant_reject') return 'REJECT' as const
  if (id === 'ascendant_escalate') return 'ESCALATE' as const
  return undefined
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
