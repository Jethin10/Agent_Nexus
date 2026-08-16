import Link from 'next/link'
import { db, inbox } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb, isLocalDb } from '@/lib/local-db'
import { DbError } from '@/components/bits'
import { LocalLedgerClient } from '@/components/local-dashboard'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Ascendant — Context ledger',
  description: 'Immutable cross-source context and the decisions it informed.',
}

export default async function LedgerPage() {
  if (isLocalDb()) return <LocalLedgerClient />
  let rows: Awaited<ReturnType<typeof inbox>> = []
  let error: unknown
  try {
    await ensureDb()
    rows = await inbox(db(), currentOrgId(), { limit: 100, order: 'newest' })
  } catch (caught) {
    error = caught
  }

  const counts = rows.reduce<Record<string, number>>((all, row) => {
    all[row.source] = (all[row.source] ?? 0) + 1
    return all
  }, {})

  return (
    <div className="ledger-page">
      <header className="ledger-header">
        <div>
          <span className="eyebrow">Immutable context</span>
          <h1>Context ledger</h1>
          <p>Emails, Slack conversations, meetings, and GitHub activity—alongside the analysis each signal produced.</p>
        </div>
        <Link className="runtime-launch" href="/integrations">Sync sources</Link>
      </header>

      {error ? <DbError error={error} /> : null}

      <section className="ledger-source-strip" aria-label="Source totals">
        {Object.entries(counts).map(([source, count]) => (
          <div key={source}><strong>{count}</strong><span>{sourceLabel(source)}</span></div>
        ))}
      </section>

      <section className="ledger-list" aria-label="Context records">
        {rows.map((row) => (
          <article className="ledger-record" key={row.eventId}>
            <div className="ledger-record-meta">
              <span className={`ledger-source source-${row.source}`}>{sourceLabel(row.source)}</span>
              <span>@{row.actorHandle}</span>
              <time>{row.createdAt.toLocaleString()}</time>
              <code>{row.sourceRef}</code>
            </div>
            <h2><Link href={`/events/${row.eventId}`}>{row.title || row.sourceRef}</Link></h2>
            <p className="ledger-body">{row.bodyPreview || '(empty source body)'}</p>
            <div className="ledger-analysis">
              <span className={`ledger-outcome outcome-${row.outcome ?? 'pending'}`}>
                {row.outcome ?? 'CONTEXT'}
              </span>
              <p>{row.reasoning || 'Stored as supporting context; no standalone decision was required.'}</p>
              {row.citations?.length ? <small>{row.citations.length} verified citation{row.citations.length === 1 ? '' : 's'}</small> : null}
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    github: 'GitHub', slack: 'Slack', gmail: 'Gmail', gcal: 'Google Calendar',
    gdrive: 'Google Drive', granola: 'Granola', linear: 'Linear',
  }
  return labels[source] ?? source
}
