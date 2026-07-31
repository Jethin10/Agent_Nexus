import Link from 'next/link'
import { TriageOutcome } from '@ascendant/core'
import { db, inbox, outcomeCounts, readPolicy } from '@ascendant/db'
import { Confidence, DbError, Empty, OutcomeBadge, Panel, Pill, when } from '@/components/bits'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'

/**
 * The Inbox — §11.1's first view, and the one the demo opens on.
 *
 * Every event with its decision, newest first, filterable by outcome. It reads Postgres
 * rather than Inngest, so history is permanent: Inngest Free retains traces for 24h and
 * Vercel Hobby logs for 1h, which means a run from Friday would be invisible on Sunday.
 *
 * The refusal counter at the top is the pitch made numeric. Four of the five outcomes
 * are refusals, and this is where that stops being a claim.
 */
export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ outcome?: string; review?: string }>
}

export default async function InboxPage({ searchParams }: Props) {
  const params = await searchParams
  const orgId = currentOrgId()

  const filter = TriageOutcome.safeParse(params.outcome)
  const needsReview = params.review === '1'

  let rows: Awaited<ReturnType<typeof inbox>> = []
  let counts: Awaited<ReturnType<typeof outcomeCounts>> = []
  let bands = { autonomous: 0.8, flagged: 0.55, injectionCeiling: 0.5 }
  let error: unknown

  try {
    await ensureDb()
    const database = db()
    ;[rows, counts, bands] = await Promise.all([
      inbox(database, orgId, {
        ...(filter.success ? { outcome: filter.data } : {}),
        ...(needsReview ? { needsReview: true } : {}),
        limit: 100,
      }),
      outcomeCounts(database, orgId),
      readPolicy(database, orgId).then((p) => p.bands),
    ])
  } catch (err) {
    error = err
  }

  const total = counts.reduce((n, c) => n + c.n, 0)
  const refused = counts.filter((c) => c.outcome !== 'ACCEPT').reduce((n, c) => n + c.n, 0)

  return (
    <>
      <h1>Inbox</h1>
      <p className="lede">
        Every event that reached the gate, with the decision it produced. Four of the five
        outcomes are refusals — that is the product, not a limitation.
      </p>

      {error ? <DbError error={error} /> : null}

      {total > 0 && (
        <Panel>
          <div className="row">
            <span>
              <span className="stat">{refused}</span>{' '}
              <span className="muted">of {total} refused before any code was written</span>
            </span>
            <span style={{ flex: 1 }} />
            {TriageOutcome.options.map((o) => {
              const hit = counts.find((c) => c.outcome === o)
              return (
                <Link key={o} href={o === filter.data ? '/' : `/?outcome=${o}`}>
                  <span className={`badge b-${o}`} style={{ opacity: hit ? 1 : 0.4 }}>
                    {o} {hit?.n ?? 0}
                  </span>
                </Link>
              )
            })}
            <Link href={needsReview ? '/' : '/?review=1'} className="small">
              {needsReview ? 'clear filter' : 'needs review'}
            </Link>
          </div>
        </Panel>
      )}

      <Panel>
        {rows.length === 0 ? (
          <Empty>
            {error
              ? 'Nothing to show until the database is reachable.'
              : 'No events yet. Ingest a webhook, or run pnpm seed:demo to load the demo corpus.'}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Outcome</th>
                <th style={{ width: 150 }}>Confidence</th>
                <th>Reasoning</th>
                <th style={{ width: 116 }}>Filed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.eventId}>
                  <td>
                    <Link href={`/events/${r.eventId}`}>
                      <strong>{r.title || r.sourceRef}</strong>
                    </Link>
                    <div className="row small dim" style={{ marginTop: 3 }}>
                      <span className="mono">{r.sourceRef}</span>
                      <span>@{r.actorHandle}</span>
                      {r.trust !== 'internal' && <Pill>{r.trust}</Pill>}
                      {r.injectionSuspected && <Pill flag>injection suspected</Pill>}
                      {r.needsReview && <Pill flag>needs review</Pill>}
                      {r.prUrl && (
                        <a href={r.prUrl} target="_blank" rel="noreferrer">
                          PR
                        </a>
                      )}
                    </div>
                  </td>
                  <td>
                    <OutcomeBadge outcome={r.outcome} />
                    {/* Left join: every decision column is null until the gate rules. */}
                    {r.policyHits && r.policyHits.length > 0 && (
                      <div className="small dim mono" style={{ marginTop: 4 }}>
                        {r.policyHits.join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    <Confidence
                      value={r.confidence}
                      autonomous={bands.autonomous}
                      flagged={bands.flagged}
                    />
                  </td>
                  <td className="muted small">
                    {r.reasoning ? clamp(r.reasoning, 190) : <span className="dim">not yet decided</span>}
                    {r.citations && r.citations.length > 0 && (
                      <div className="dim small mono" style={{ marginTop: 4 }}>
                        cites {r.citations.length} · {r.modelUsed}
                      </div>
                    )}
                  </td>
                  <td className="small dim mono">{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}

function clamp(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s
}
