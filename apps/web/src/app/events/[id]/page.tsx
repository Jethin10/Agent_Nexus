import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  db,
  decisionForEvent,
  getEvent,
  readPolicy,
  runTrace,
  ticketTrace,
} from '@ascendant/db'
import { Confidence, DbError, Empty, OutcomeBadge, Panel, Pill, when } from '@/components/bits'
import { currentOrgId, demoMode } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'
import { Timeline } from '@/components/timeline'
import { ReplayTimeline } from '@/components/replay-timeline'
import { TicketFor } from '@/components/ticket'

/**
 * Run Detail — §11.1's second view, and where the "agents argue with each other" claim
 * has to become *legible*.
 *
 * It renders as a structured thread rather than a wall of scrolling text: the decision
 * object with its citations first, then the timeline from `agent_events`. Reading our
 * own table rather than Inngest's dashboard is what makes this work on demo day, when
 * a Friday run's vendor traces are long gone.
 */
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function EventPage({ params }: Props) {
  const { id } = await params
  const orgId = currentOrgId()

  try {
    await ensureDb()
    const database = db()
    const event = await getEvent(database, orgId, id)
    if (!event) notFound()

    const [decision, bands] = await Promise.all([
      decisionForEvent(database, orgId, id),
      readPolicy(database, orgId).then((p) => p.bands),
    ])

    const ticket = decision ? await TicketFor({ orgId, eventId: id }) : null

    // A triage that never opened a ticket still has a trace, keyed by run rather than
    // ticket — four of five outcomes end there, so this is the common case.
    const timeline = ticket?.id
      ? await ticketTrace(database, orgId, ticket.id)
      : decision
        ? await traceForDecisionRun(database, orgId, id)
        : []

    return (
      <>
        <p className="small">
          <Link href="/">← Inbox</Link>
        </p>
        <h1>{event.title || event.sourceRef}</h1>
        <div className="row small dim" style={{ marginBottom: 18 }}>
          <span className="mono">{event.sourceRef}</span>
          <span>
            {event.source}:{event.kind}
          </span>
          <span>@{event.actorHandle}</span>
          <Pill>{event.trust}</Pill>
          {event.actorIsBot && <Pill flag>bot</Pill>}
          {event.injectionSuspected && <Pill flag>injection suspected</Pill>}
          <span className="mono">{when(event.createdAt)}</span>
        </div>

        {decision ? (
          <Panel title="The decision">
            <div className="row" style={{ marginBottom: 10 }}>
              <OutcomeBadge outcome={decision.outcome} />
              <Confidence
                value={decision.confidence}
                autonomous={bands.autonomous}
                flagged={bands.flagged}
              />
              {decision.autonomous ? (
                <Pill>acted autonomously</Pill>
              ) : (
                <Pill flag>human in the loop</Pill>
              )}
              <span className="dim small mono">{decision.modelUsed}</span>
              {decision.latencyMs > 0 && (
                <span className="dim small mono">
                  {decision.latencyMs}ms · {decision.tokens} tokens
                </span>
              )}
            </div>

            <p style={{ margin: '0 0 12px' }}>{decision.reasoning}</p>

            {/* All three components, stored per-decision so calibration is auditable
                after the fact rather than being a number nobody can reconstruct. */}
            <div className="row small dim" style={{ marginBottom: 12 }}>
              <span>confidence =</span>
              <span className="mono">
                0.5 × {fmt(decision.modelSelfReport)} (self-report)
              </span>
              <span>+</span>
              <span className="mono">0.3 × {fmt(decision.evidenceStrength)} (evidence)</span>
              <span>+</span>
              <span className="mono">0.2 × {fmt(decision.policyAgreement)} (rules agree)</span>
            </div>

            {decision.policyHits.length > 0 && (
              <p className="small">
                <span className="muted">Deterministic rules that fired: </span>
                <span className="mono">{decision.policyHits.join(', ')}</span>
                {decision.modelUsed === 'policy' && (
                  <span className="muted"> — no model was called at all.</span>
                )}
              </p>
            )}

            {decision.missingInfo.length > 0 && (
              <>
                <h2 style={{ marginTop: 14 }}>What it asked for</h2>
                <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                  {decision.missingInfo.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </>
            )}

            <h2 style={{ marginTop: 14 }}>Evidence</h2>
            {decision.citations.length === 0 ? (
              <Empty>No citations — which should be impossible; the schema requires one.</Empty>
            ) : (
              decision.citations.map((c, i) => (
                <div key={`${c.ref}-${i}`} style={{ marginBottom: 10 }}>
                  <div className="row small">
                    <Pill>{c.kind}</Pill>
                    {c.ref.startsWith('http') ? (
                      <a href={c.ref} target="_blank" rel="noreferrer" className="mono">
                        {c.ref}
                      </a>
                    ) : (
                      <span className="mono">{c.ref}</span>
                    )}
                  </div>
                  <blockquote className="small">{c.quote}</blockquote>
                  <p className="dim small" style={{ margin: 0 }}>
                    {c.why}
                  </p>
                </div>
              ))
            )}
          </Panel>
        ) : (
          <Panel title="The decision">
            <Empty>This event has not been triaged yet.</Empty>
          </Panel>
        )}

        {ticket && (
          <Panel title="Ticket">
            <div className="row small">
              <Pill>{ticket.status}</Pill>
              {ticket.branch && <span className="mono">{ticket.branch}</span>}
              {ticket.prUrl && (
                <a href={ticket.prUrl} target="_blank" rel="noreferrer">
                  PR #{ticket.prNumber}
                  {ticket.prIsDraft ? ' (draft)' : ''}
                </a>
              )}
              <span className="dim mono">
                {ticket.tokensUsed} tokens · {ticket.llmCalls} calls
              </span>
            </div>
          </Panel>
        )}

        <Panel title="The run">
          {timeline.length === 0 ? (
            <Empty>No trace rows for this event yet.</Empty>
          ) : demoMode() === 'replay' ? (
            /* Same rows, same renderer — only the pacing is reconstructed (§16.3). */
            <ReplayTimeline rows={timeline} />
          ) : (
            <Timeline rows={timeline} />
          )}
        </Panel>

        <Panel title="The event as ingested">
          <p className="small dim" style={{ marginTop: 0 }}>
            Extracted deterministically by regex, not by a model — these are the join keys
            retrieval uses.
          </p>
          <div className="row small">
            {extractedPills(event.extracted).map(([label, value]) => (
              <Pill key={label}>
                {label}: {value}
              </Pill>
            ))}
          </div>
          <pre className="block small">{event.body.slice(0, 4_000) || '(empty body)'}</pre>
        </Panel>
      </>
    )
  } catch (err) {
    if (isNotFound(err)) throw err
    return (
      <>
        <h1>Event</h1>
        <DbError error={err} />
      </>
    )
  }
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(2)
}

function extractedPills(e: {
  symbols: string[]
  versions: string[]
  stackFrames: string[]
  issueRefs: string[]
  urls: string[]
}): [string, string][] {
  const out: [string, string][] = []
  if (e.symbols.length) out.push(['symbols', e.symbols.slice(0, 6).join(' ')])
  if (e.versions.length) out.push(['versions', e.versions.join(' ')])
  if (e.issueRefs.length) out.push(['refs', e.issueRefs.join(' ')])
  if (e.stackFrames.length) out.push(['stack frames', String(e.stackFrames.length)])
  if (e.urls.length) out.push(['urls', String(e.urls.length)])
  return out
}

/** Next's notFound() throws a sentinel; it must not be swallowed by the DB catch. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    String((err as { digest?: unknown }).digest).startsWith('NEXT_')
  )
}

/** Trace rows for the triage run of an event that never became a ticket. */
async function traceForDecisionRun(
  database: ReturnType<typeof db>,
  orgId: string,
  eventId: string,
) {
  const { runsForEvent } = await import('@/lib/runs')
  const ids = await runsForEvent(database, orgId, eventId)
  const all = await Promise.all(ids.map((rid) => runTrace(database, orgId, rid)))
  return all.flat().sort((a, b) => a.at.getTime() - b.at.getTime())
}
