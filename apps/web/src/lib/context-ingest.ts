import { normalize, type RawEvent } from '@ascendant/core'
import { gmailReader, slackHistoryReader } from '@ascendant/connectors'
import { db, insertEvent, readPolicy } from '@ascendant/db'
import { scanForInjection } from '@ascendant/router'
import { inngest } from '@ascendant/workflows'
import { ensureDb } from './local-db'

export interface ContextSyncResult {
  source: 'gmail' | 'slack'
  read: number
  inserted: number
  dispatched: number
}

export async function persistContextEvents(raws: readonly RawEvent[]) {
  await ensureDb()
  const database = db()
  const policyByOrg = new Map<string, Awaited<ReturnType<typeof readPolicy>>>()
  let inserted = 0
  let dispatched = 0

  for (const raw of raws) {
    let policy = policyByOrg.get(raw.orgId)
    if (!policy) {
      policy = await readPolicy(database, raw.orgId)
      policyByOrg.set(raw.orgId, policy)
    }
    const guard = await scanForInjection(
      `${raw.title}\n\n${raw.body}`,
      `${raw.source}:${raw.kind}:${raw.sourceRef}`,
      { env: { GROQ_API_KEY: process.env.GROQ_API_KEY } },
    )
    const event = normalize(raw, {
      internalActors: policy.internalActors,
      knownExternalActors: policy.knownExternalActors,
      injectionSuspected: guard.suspected,
    })
    const saved = await insertEvent(database, event)
    if (saved.inserted) inserted += 1

    if (process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV === '1') {
      await inngest.send({
        id: `ascendant:event:${saved.row.id}`,
        name: 'event/received',
        data: {
          orgId: raw.orgId,
          eventId: saved.row.id,
          source: saved.row.source,
          sourceRef: saved.row.sourceRef,
        },
      })
      dispatched += 1
    }
  }
  return { inserted, dispatched }
}

export async function syncConfiguredContext(orgId: string): Promise<ContextSyncResult[]> {
  const results: ContextSyncResult[] = []

  const gmailReady = process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN
  if (gmailReady) {
    const raws = await gmailReader({
      clientId: process.env.GMAIL_CLIENT_ID as string,
      clientSecret: process.env.GMAIL_CLIENT_SECRET as string,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN as string,
      query: process.env.GMAIL_QUERY,
      maxMessages: positiveInt(process.env.GMAIL_MAX_MESSAGES, 25),
    }).read(orgId)
    const stored = await persistContextEvents(raws)
    results.push({ source: 'gmail', read: raws.length, ...stored })
  }

  const slackChannel = process.env.SLACK_INGEST_CHANNEL_ID || process.env.SLACK_CHANNEL_ID
  if (process.env.SLACK_BOT_TOKEN && slackChannel) {
    const raws = await slackHistoryReader({
      token: process.env.SLACK_BOT_TOKEN,
      channel: slackChannel,
      maxMessages: positiveInt(process.env.SLACK_MAX_MESSAGES, 40),
    }).read(orgId)
    const stored = await persistContextEvents(raws)
    results.push({ source: 'slack', read: raws.length, ...stored })
  }

  return results
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
