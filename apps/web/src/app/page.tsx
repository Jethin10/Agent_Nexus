import { db, inbox } from '@ascendant/db'
import { CommandCenterDashboard, type CommandCenterRow } from '@/components/command-center-dashboard'
import { currentOrgId } from '@/lib/org'
import { ensureDb, isLocalDb } from '@/lib/local-db'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ selected?: string; q?: string; review?: string }>
}

export default async function InboxPage({ searchParams }: Props) {
  const { selected, q, review } = await searchParams

  if (process.env.ASCENDANT_DEMO_MODE === '1') {
    return <CommandCenterDashboard initialRows={DEMO_ROWS} selectedId={selected} initialQuery={q} initialTab={review === '1' ? 'approval' : 'all'} demo />
  }

  if (isLocalDb()) {
    return <CommandCenterDashboard initialRows={[]} selectedId={selected} initialQuery={q} initialTab={review === '1' ? 'approval' : 'all'} liveLocal />
  }

  let rows: CommandCenterRow[] = []
  let error: string | undefined

  try {
    await ensureDb()
    const result = await inbox(db(), currentOrgId(), { limit: 100, order: 'newest' })
    rows = result.map((row) => ({
      ...row,
      confidence: row.confidence === null ? null : Number(row.confidence),
      createdAt: row.createdAt.toISOString(),
    }))
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  return <CommandCenterDashboard initialRows={rows} selectedId={selected} initialQuery={q} initialTab={review === '1' ? 'approval' : 'all'} error={error} />
}

const DEMO_ROWS: CommandCenterRow[] = [
  {
    eventId: 'demo-auth-refresh', source: 'github', sourceRef: 'acme/api#1045',
    title: 'Fix session refresh race in API gateway',
    bodyPreview: 'Customers are intermittently signed out during token rotation.',
    actorHandle: 'maya', trust: 'trusted', createdAt: '2026-08-22T06:42:00.000Z',
    outcome: 'ACCEPT', confidence: 0.94,
    reasoning: 'The regression is reproducible, customer-impacting, and isolated to the refresh lock.',
    citations: [{ ref: 'issue#1045' }, { ref: 'trace/auth-77' }, { ref: 'src/session.ts' }],
    policyHits: [], needsReview: false, ticketId: 'demo-ticket-1', ticketStatus: 'done',
    prUrl: 'https://github.com/Jethin10/Agent_Nexus',
  },
  {
    eventId: 'demo-export', source: 'slack', sourceRef: '#customer-requests',
    title: 'Add workspace audit-log export',
    bodyPreview: 'Enterprise prospect needs a scheduled compliance export.',
    actorHandle: 'sam', trust: 'known', createdAt: '2026-08-22T07:18:00.000Z',
    outcome: 'ESCALATE', confidence: 0.76,
    reasoning: 'Strong commercial signal, but retention scope and delivery format need owner approval.',
    citations: [{ ref: 'slack/thread-882' }, { ref: 'security/retention' }],
    policyHits: ['security-review', 'data-retention'], needsReview: true,
    ticketId: 'demo-ticket-2', ticketStatus: 'review', prUrl: null,
  },
  {
    eventId: 'demo-latency', source: 'gmail', sourceRef: 'support/4281',
    title: 'Investigate webhook delivery latency',
    bodyPreview: 'Webhook processing crossed the five-second SLO twice this morning.',
    actorHandle: 'ops', trust: 'trusted', createdAt: '2026-08-22T07:51:00.000Z',
    outcome: 'ACCEPT', confidence: 0.88,
    reasoning: 'Telemetry identifies a bounded queue-consumer bottleneck with a safe remediation path.',
    citations: [{ ref: 'incident/4281' }, { ref: 'metrics/webhook-p95' }],
    policyHits: [], needsReview: false, ticketId: 'demo-ticket-3', ticketStatus: 'coding', prUrl: null,
  },
  {
    eventId: 'demo-theme', source: 'github', sourceRef: 'acme/web#991',
    title: 'Add another dashboard theme',
    bodyPreview: 'Request for a third color theme without supporting research.',
    actorHandle: 'community', trust: 'unknown', createdAt: '2026-08-22T08:04:00.000Z',
    outcome: 'DECLINE', confidence: 0.91,
    reasoning: 'The request has no validated user need and duplicates existing personalization controls.',
    citations: [{ ref: 'issue#991' }], policyHits: ['evidence-minimum'], needsReview: false,
    ticketId: null, ticketStatus: null, prUrl: null,
  },
]
