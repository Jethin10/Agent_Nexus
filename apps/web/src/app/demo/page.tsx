import { db, inbox } from '@ascendant/db'
import { ensureDb } from '@/lib/local-db'
import { currentOrgId } from '@/lib/org'
import { DemoJourney, type DemoCase, type IntegrationState } from '@/components/demo-journey'

export const metadata = {
  title: 'Ascendant — The decision layer before code',
  description: 'See real persisted Triage Gate decisions and their verified evidence.',
}

export const dynamic = 'force-dynamic'

const REFS = ['acme/api#1041', 'acme/api#1042', 'acme/api#1043', 'acme/api#1044', 'acme/api#1045']

export default async function DemoPage() {
  let rows: Awaited<ReturnType<typeof inbox>> = []
  try {
    await ensureDb()
    rows = await inbox(db(), currentOrgId(), { limit: 100, order: 'newest' })
  } catch {
    // The setup state below is more useful than a stack trace on a fresh checkout.
  }
  const cases: DemoCase[] = REFS.flatMap((ref) => {
    const row = rows.find((candidate) => candidate.sourceRef === ref && candidate.decisionId)
    if (!row?.decisionId || !row.outcome || row.confidence === null) return []
    return [{
      eventId: row.eventId,
      decisionId: row.decisionId,
      sourceRef: row.sourceRef,
      title: row.title || row.sourceRef,
      outcome: row.outcome,
      confidence: Number(row.confidence),
      reasoning: row.reasoning || '',
      citations: row.citations ?? [],
      policyHits: row.policyHits ?? [],
      autonomous: row.autonomous ?? false,
      modelUsed: row.modelUsed ?? 'unknown',
      ticketId: row.ticketId ?? null,
      ticketStatus: row.ticketStatus ?? null,
      prUrl: row.prUrl ?? null,
    }]
  })

  const integrations: IntegrationState[] = [
    state('GitHub', Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO), 'ingest + PR delivery'),
    state('Linear', Boolean(process.env.LINEAR_API_KEY && process.env.LINEAR_TEAM_ID), 'work item mirror'),
    state('Slack', Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID), 'review + notification'),
    state('Inngest', Boolean(process.env.INNGEST_EVENT_KEY), 'durable execution'),
    state('Sandbox', Boolean(process.env.E2B_API_KEY || process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1'), process.env.E2B_API_KEY ? 'E2B isolation' : 'local demo driver'),
  ]

  return <DemoJourney cases={cases} integrations={integrations} />
}

function state(name: string, ready: boolean, detail: string): IntegrationState {
  return { name, ready, detail }
}
