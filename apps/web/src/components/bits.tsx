import type { TriageOutcome } from '@ascendant/core'

/**
 * Shared display pieces. Server components, no client JS: every view here reads
 * Postgres and renders, so there is nothing to hydrate.
 */

/** One hue per outcome, so the Inbox's shape is readable from across a room. */
export function OutcomeBadge({ outcome }: { outcome: TriageOutcome | null | undefined }) {
  if (!outcome) return <span className="badge b-none">pending</span>
  return <span className={`badge b-${outcome}`}>{outcome}</span>
}

const CONF_COLOR = (c: number, autonomous: number, flagged: number) =>
  c >= autonomous ? 'var(--accept)' : c >= flagged ? 'var(--defer)' : 'var(--escalate)'

/**
 * The confidence bar carries the band thresholds as tick marks rather than only a
 * number. The demo's fourth beat drags the autonomy threshold live, and the point only
 * lands if you can see the bar cross the line.
 */
export function Confidence({
  value,
  autonomous = 0.8,
  flagged = 0.55,
}: {
  value: number | null | undefined
  autonomous?: number
  flagged?: number
}) {
  if (value === null || value === undefined) return <span className="dim">—</span>
  const pct = Math.round(value * 100)
  return (
    <div className="conf">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
        <span className="mono small">{value.toFixed(2)}</span>
        <span className="dim small">{pct >= autonomous * 100 ? 'autonomous' : 'human in loop'}</span>
      </div>
      <div className="conf-track" style={{ position: 'relative' }}>
        <div
          className="conf-fill"
          style={{ width: `${pct}%`, background: CONF_COLOR(value, autonomous, flagged) }}
        />
        <span
          title={`autonomy threshold ${autonomous}`}
          style={{
            position: 'absolute',
            left: `${autonomous * 100}%`,
            top: -2,
            width: 1,
            height: 9,
            background: 'var(--text)',
            opacity: 0.55,
          }}
        />
      </div>
    </div>
  )
}

export function Pill({ children, flag = false }: { children: React.ReactNode; flag?: boolean }) {
  return <span className={flag ? 'pill flag' : 'pill'}>{children}</span>
}

export function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      {title && <h2>{title}</h2>}
      {children}
    </section>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="muted small">{children}</p>
}

export function when(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toISOString().replace('T', ' ').slice(0, 16)
}

/**
 * Surfaces a missing DATABASE_URL as an explanation rather than a stack trace. Neon
 * Free *suspends* compute on exceeding a limit rather than throttling (§13.1), so "the
 * dashboard is blank" needs to distinguish "nothing ingested yet" from "the database is
 * gone" — those have very different answers on demo day.
 */
export function DbError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  const unset = /DATABASE_URL/.test(message)
  return (
    <div className="banner">
      <strong>{unset ? 'No database is configured.' : 'The database is unreachable.'}</strong>
      <p className="small" style={{ margin: '6px 0 0' }}>
        {unset ? (
          <>
            Set <code>DATABASE_URL</code> to a Neon connection string and run{' '}
            <code>pnpm db:push</code>. The offline path is a local Postgres with pgvector
            plus the committed <code>pg_dump</code>.
          </>
        ) : (
          <span className="mono">{message.slice(0, 300)}</span>
        )}
      </p>
    </div>
  )
}
