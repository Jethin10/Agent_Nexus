import Link from 'next/link'
import { TriageOutcome, type TriageOutcome as Outcome } from '@ascendant/core'
import { db, inbox } from '@ascendant/db'
import { DbError } from '@/components/bits'
import { currentOrgId } from '@/lib/org'
import { ensureDb, isLocalDb } from '@/lib/local-db'
import { LocalInboxClient } from '@/components/local-dashboard'
import { LiveRefresh } from '@/components/live-refresh'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{
    outcome?: string
    review?: string
    q?: string
    order?: string
    selected?: string
  }>
}

type InboxRow = Awaited<ReturnType<typeof inbox>>[number]

const OUTCOMES: Outcome[] = ['ACCEPT', 'REJECT', 'MERGE', 'DEFER', 'ESCALATE']

export default async function InboxPage({ searchParams }: Props) {
  if (isLocalDb()) return <LocalInboxClient />
  const params = await searchParams
  const orgId = currentOrgId()
  const outcome = TriageOutcome.safeParse(params.outcome)
  const needsReview = params.review === '1'
  const query = params.q?.trim() ?? ''

  let rows: InboxRow[] = []
  let error: unknown

  try {
    await ensureDb()
    rows = await inbox(db(), orgId, {
      ...(outcome.success ? { outcome: outcome.data } : {}),
      ...(needsReview ? { needsReview: true } : {}),
      ...(query ? { query } : {}),
      order: params.order === 'oldest' ? 'oldest' : 'newest',
      limit: 100,
    })
  } catch (err) {
    error = err
  }

  const visibleRows = rows
  const selected =
    visibleRows.find((row) => row.eventId === params.selected) ??
    visibleRows.find((row) => row.needsReview || row.outcome === 'ESCALATE') ??
    visibleRows[0]

  return (
    <div className="inbox-workspace">
      <header className="workspace-toolbar">
        <LiveRefresh />
        <Link className="runtime-launch" href="/integrations">
          <span className="runtime-launch-dot" />
          Runtime status
        </Link>
        <form className="search-form" method="get">
          <button className="search-submit" type="submit" aria-label="Submit search">
            <SearchIcon />
          </button>
          <input name="q" defaultValue={params.q} placeholder="Search inbox" aria-label="Search inbox" />
          {outcome.success && <input type="hidden" name="outcome" value={outcome.data} />}
          {needsReview && <input type="hidden" name="review" value="1" />}
          <span className="key-hint">⌘ /</span>
        </form>

        <details className="filter-menu">
          <summary>
            <FilterIcon />
            Filter
            <ChevronDownIcon />
          </summary>
          <div className="filter-popover">
            <Link href={hrefWith(params, { outcome: null, review: null })}>All signals</Link>
            <Link href={hrefWith(params, { review: '1', outcome: null })}>Needs review</Link>
            <span className="filter-divider" />
            {OUTCOMES.map((item) => (
              <Link key={item} href={hrefWith(params, { outcome: item, review: null })}>
                {labelOutcome(item)}
              </Link>
            ))}
          </div>
        </details>

        <Link
          className="sort-control"
          href={hrefWith(params, { order: params.order === 'oldest' ? null : 'oldest' })}
        >
          <SortIcon />
          {params.order === 'oldest' ? 'Oldest' : 'Newest'}
          <ChevronDownIcon />
        </Link>
      </header>

      <div className="inbox-body">
        <section className="signal-region" aria-labelledby="triage-inbox-title">
          <div className="signal-heading">
            <div>
              <h1 id="triage-inbox-title">Triage inbox</h1>
              <p>Signals that need a product decision</p>
            </div>
            {(outcome.success || needsReview || query) && (
              <Link className="clear-filter" href="/">
                Clear filters
              </Link>
            )}
          </div>

          {error ? <DbError error={error} /> : null}

          <div className="signal-table" role="table" aria-label="Triage inbox">
            <div className="signal-table-head" role="row">
              <span role="columnheader">Source</span>
              <span role="columnheader">Title</span>
              <span role="columnheader">Customer context</span>
              <span role="columnheader">Decision state</span>
            </div>
            {visibleRows.length === 0 ? (
              <div className="signal-empty">
                <strong>No matching signals</strong>
                <span>Try a broader search or clear the active filters.</span>
              </div>
            ) : (
              visibleRows.map((row) => (
                <Link
                  key={row.eventId}
                  href={hrefWith(params, { selected: row.eventId })}
                  className={`signal-row${selected?.eventId === row.eventId ? ' is-selected' : ''}`}
                  role="row"
                  scroll={false}
                >
                  <span className="source-cell" role="cell">
                    <SourceMark source={row.source} />
                    {sourceLabel(row.source)}
                  </span>
                  <span className="title-cell" role="cell">
                    <strong>{row.title || row.sourceRef}</strong>
                    <small>{row.sourceRef}</small>
                  </span>
                  <span className="context-cell" role="cell">
                    {trustLabel(row.trust)}
                  </span>
                  <span className="decision-cell" role="cell">
                    <span className={`decision-dot d-${row.outcome ?? 'pending'}`} />
                    {row.outcome ? labelOutcome(row.outcome) : 'Needs decision'}
                  </span>
                </Link>
              ))
            )}
          </div>
        </section>

        <aside
          className={`decision-inspector${params.selected ? ' is-open' : ''}`}
          aria-label="Selected decision"
        >
          {selected ? (
            <DecisionInspector row={selected} closeHref={hrefWith(params, { selected: null })} />
          ) : (
            <EmptyInspector />
          )}
        </aside>
      </div>
    </div>
  )
}

function DecisionInspector({ row, closeHref }: { row: InboxRow; closeHref: string }) {
  const confidence = row.confidence === null ? null : Math.round(Number(row.confidence) * 100)
  const citations = row.citations ?? []
  const policyHits = row.policyHits ?? []

  return (
    <div className="inspector-inner">
      <div className="inspector-topline">
        <span>{sourceLabel(row.source)} · {row.sourceRef}</span>
        <Link href={closeHref} aria-label="Close decision inspector">
          <CloseIcon />
        </Link>
      </div>

      <h2>{row.title || row.sourceRef}</h2>

      <dl className="decision-summary">
        <div>
          <dt>Decision</dt>
          <dd className={`outcome-text o-${row.outcome ?? 'pending'}`}>
            {row.outcome ? labelOutcome(row.outcome) : 'Pending'}
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{confidence === null ? 'Not scored' : `${confidence}% confidence`}</dd>
        </div>
      </dl>

      <section className="inspector-section">
        <h3>Evidence</h3>
        <EvidenceItem icon={<SourceMark source={row.source} large />} title={sourceLabel(row.source)}>
          {row.sourceRef} · @{row.actorHandle} · {row.bodyPreview.slice(0, 180) || 'empty body'}
        </EvidenceItem>
        <EvidenceItem icon={<QuoteIcon />} title="Decision rationale">
          {row.reasoning || 'Awaiting enough context to make a decision.'}
        </EvidenceItem>
        <EvidenceItem icon={<EvidenceIcon />} title="Supporting references">
          {citations.length > 0
            ? `${citations.length} cited source${citations.length === 1 ? '' : 's'}`
            : 'No external citations attached'}
        </EvidenceItem>
      </section>

      <section className="policy-alignment">
        <span>Policy alignment</span>
        <strong>{policyHits.length > 0 ? policyHits.join(', ') : 'No blocking rule'}</strong>
      </section>

      <div className="inspector-action">
        <Link className="primary-action" href={`/events/${row.eventId}`}>
          Open review
          <span>↵</span>
        </Link>
      </div>
    </div>
  )
}

function EvidenceItem({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="evidence-item">
      <span className="evidence-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{children}</small>
      </span>
    </div>
  )
}

function EmptyInspector() {
  return (
    <div className="empty-inspector">
      <EvidenceIcon />
      <strong>Select a signal</strong>
      <span>Its decision and supporting evidence will appear here.</span>
    </div>
  )
}

function hrefWith(
  current: Awaited<Props['searchParams']>,
  changes: Record<string, string | null>,
): string {
  const next = new URLSearchParams()
  for (const key of ['q', 'outcome', 'review', 'order', 'selected'] as const) {
    const value = current[key]
    if (value) next.set(key, value)
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key)
    else next.set(key, value)
  }
  const query = next.toString()
  return query ? `/?${query}` : '/'
}

function labelOutcome(outcome: string): string {
  return outcome.charAt(0) + outcome.slice(1).toLowerCase()
}

function trustLabel(trust: string): string {
  if (trust === 'internal') return 'Internal team'
  if (trust === 'known_external') return 'Known contributor'
  return 'External signal'
}

function sourceLabel(source: string): string {
  if (source.toLowerCase().includes('github')) return 'GitHub'
  if (source.toLowerCase().includes('linear')) return 'Linear'
  if (source.toLowerCase().includes('slack')) return 'Slack'
  if (source.toLowerCase().includes('gmail')) return 'Gmail'
  if (source.toLowerCase().includes('granola')) return 'Granola'
  return source.charAt(0).toUpperCase() + source.slice(1)
}

function SourceMark({ source, large = false }: { source: string; large?: boolean }) {
  const name = sourceLabel(source)
  return (
    <span className={`source-mark source-${name.toLowerCase()}${large ? ' source-mark-large' : ''}`}>
      {name === 'GitHub' ? <GitHubIcon /> : name === 'Slack' ? <SlackIcon /> : name === 'Gmail' ? <MailIcon /> : name === 'Linear' ? <LinearIcon /> : <SignalIcon />}
    </span>
  )
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
}
function FilterIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h8M8.5 15h3" /></svg>
}
function SortIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3v14m0 0-3-3m3 3 3-3M14 17V3m0 0-3 3m3-3 3 3" /></svg>
}
function ChevronDownIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
}
function CloseIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
}
function GitHubIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a7.5 7.5 0 0 0-2.37 14.62c.38.07.51-.16.51-.36v-1.47c-2.09.45-2.53-.89-2.53-.89-.34-.87-.84-1.1-.84-1.1-.68-.47.05-.46.05-.46.76.05 1.15.78 1.15.78.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.42-.83-3.42-3.71 0-.82.29-1.49.77-2.01-.08-.19-.33-.96.07-1.99 0 0 .63-.2 2.06.77A7.2 7.2 0 0 1 10 6.25c.64 0 1.28.09 1.88.25 1.43-.97 2.06-.77 2.06-.77.4 1.03.15 1.8.07 1.99.48.52.77 1.19.77 2.01 0 2.88-1.76 3.51-3.43 3.7.27.23.51.69.51 1.39v1.94c0 .2.14.44.52.36A7.5 7.5 0 0 0 10 2.5Z" /></svg>
}
function SlackIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.3 2.5a1.8 1.8 0 1 1 0 3.6H5.5V4.3c0-1 .8-1.8 1.8-1.8Zm0 4.5c1 0 1.8.8 1.8 1.8v4.5a1.8 1.8 0 1 1-3.6 0V8.8C5.5 7.8 6.3 7 7.3 7Zm10.2 1.8a1.8 1.8 0 1 1-3.6 0V7h1.8c1 0 1.8.8 1.8 1.8Zm-4.5 0c0 1-.8 1.8-1.8 1.8H6.7a1.8 1.8 0 1 1 0-3.6h4.5c1 0 1.8.8 1.8 1.8Zm-1.8 8.7a1.8 1.8 0 1 1 0-3.6H13v1.8c0 1-.8 1.8-1.8 1.8Zm0-4.5c-1 0-1.8-.8-1.8-1.8V6.7a1.8 1.8 0 1 1 3.6 0v4.5c0 1-.8 1.8-1.8 1.8ZM2.5 11.2a1.8 1.8 0 1 1 3.6 0V13H4.3c-1 0-1.8-.8-1.8-1.8Zm4.5 0c0-1 .8-1.8 1.8-1.8h4.5a1.8 1.8 0 1 1 0 3.6H8.8c-1 0-1.8-.8-1.8-1.8Z" /></svg>
}
function LinearIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.2 12.7 7.3 16.8a7.4 7.4 0 0 1-4.1-4.1Zm-.7-3.5 8.3 8.3a7.5 7.5 0 0 1-1.7-.1l-6.5-6.5a7.5 7.5 0 0 1-.1-1.7Zm.8-2.7 10.2 10.2c-.4.2-.8.4-1.3.5L2.8 7.8c.1-.5.3-.9.5-1.3Zm1.5-2.1a7.5 7.5 0 1 1 10.8 10.8L4.8 4.4Z" /></svg>
}
function SignalIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2" /><path d="M5.8 14.2a6 6 0 0 1 0-8.4M14.2 5.8a6 6 0 0 1 0 8.4" /></svg>
}
function MailIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14v10H3zM3 6l7 5 7-5" /></svg>
}
function QuoteIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13v9h-7l-4 2.5v-2.5h-2zM6.5 8h7M6.5 10.5h4.5" /></svg>
}
function EvidenceIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg>
}
