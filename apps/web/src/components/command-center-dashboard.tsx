'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

export interface CommandCenterRow {
  eventId: string
  source: string
  sourceRef: string
  title: string
  bodyPreview: string
  actorHandle: string
  trust: string
  createdAt: string
  outcome: string | null
  confidence: number | null
  reasoning: string | null
  citations: unknown[] | null
  policyHits: string[] | null
  needsReview: boolean | null
  ticketId: string | null
  ticketStatus: string | null
  prUrl: string | null
}

type InboxTab = 'all' | 'approval' | 'running' | 'done'

export function CommandCenterDashboard({ initialRows, selectedId, initialQuery = '', initialTab = 'all', liveLocal = false, error: initialError }: {
  initialRows: CommandCenterRow[]
  selectedId?: string
  initialQuery?: string
  initialTab?: InboxTab
  liveLocal?: boolean
  error?: string
}) {
  const [rows, setRows] = useState(initialRows)
  const [selected, setSelected] = useState(selectedId ?? initialRows.find((row) => row.needsReview)?.eventId ?? initialRows[0]?.eventId)
  const [query, setQuery] = useState(initialQuery)
  const [tab, setTab] = useState<InboxTab>(initialTab)
  const [error, setError] = useState(initialError)

  useEffect(() => { setQuery(initialQuery); setTab(initialTab) }, [initialQuery, initialTab])

  const refreshLocal = useCallback(async () => {
    try {
      const response = await fetch('/api/local/inbox', { cache: 'no-store' })
      const payload = await response.json() as { rows?: CommandCenterRow[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setRows(payload.rows ?? [])
      setError(undefined)
      setSelected((current) => current ?? payload.rows?.find((row) => row.needsReview)?.eventId ?? payload.rows?.[0]?.eventId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (!liveLocal) return
    void refreshLocal()
    const timer = window.setInterval(() => void refreshLocal(), 5_000)
    return () => window.clearInterval(timer)
  }, [liveLocal, refreshLocal])

  const counts = useMemo(() => ({
    all: rows.length,
    approval: rows.filter((row) => row.needsReview).length,
    running: rows.filter((row) => row.ticketStatus && !row.prUrl).length,
    done: rows.filter((row) => row.prUrl || row.ticketStatus === 'done').length,
  }), [rows])

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      const tabMatches = tab === 'all' || (tab === 'approval' && row.needsReview) || (tab === 'running' && row.ticketStatus && !row.prUrl) || (tab === 'done' && (row.prUrl || row.ticketStatus === 'done'))
      return tabMatches && (!needle || `${row.title} ${row.sourceRef} ${row.actorHandle} ${row.reasoning ?? ''}`.toLowerCase().includes(needle))
    })
  }, [query, rows, tab])

  const active = rows.find((row) => row.eventId === selected) ?? visibleRows[0] ?? rows[0]

  return (
    <div className="command-center">
      <section className="command-inbox" aria-labelledby="command-inbox-title">
        <header className="command-panel-header">
          <h1 id="command-inbox-title">Inbox</h1>
          <span className={`sync-state${liveLocal ? ' is-live' : ''}`}><i />{liveLocal ? 'Live' : 'Synced'}</span>
        </header>
        <label className="command-search"><SearchIcon /><span className="sr-only">Search runs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" /></label>
        <div className="command-tabs" role="tablist" aria-label="Inbox filters">
          {(['all', 'approval', 'running', 'done'] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
              {item === 'all' ? 'All' : item === 'approval' ? 'Approval' : item === 'running' ? 'Running' : 'Done'}<span>{counts[item]}</span>
            </button>
          ))}
        </div>
        {error ? <div className="command-error" role="alert"><strong>Inbox unavailable</strong><span>{error}</span></div> : null}
        <div className="command-run-list">
          {visibleRows.length ? visibleRows.map((row) => (
            <button className={`run-list-item${active?.eventId === row.eventId ? ' is-selected' : ''}`} key={row.eventId} type="button" onClick={() => setSelected(row.eventId)} aria-pressed={active?.eventId === row.eventId}>
              <div className="run-list-title"><strong>{row.title || row.sourceRef}</strong><StatusBadge row={row} /></div>
              <div className="run-list-meta"><SourceIcon source={row.source} /><span>{sourceLabel(row.source)}</span><span>·</span><code>{row.sourceRef}</code></div>
              <div className="run-list-foot"><span>@{row.actorHandle}</span><time dateTime={row.createdAt} suppressHydrationWarning>{relativeTime(row.createdAt)}</time></div>
            </button>
          )) : <div className="command-empty"><strong>No matching runs</strong><span>Connect a source or clear the current filter.</span></div>}
        </div>
      </section>
      <main className="run-canvas">{active ? <RunCanvas row={active} /> : <EmptyRun />}</main>
      <aside className="run-inspector" aria-label="Run evidence and details">{active ? <RunInspector row={active} /> : <EmptyInspector />}</aside>
    </div>
  )
}

function RunCanvas({ row }: { row: CommandCenterRow }) {
  const stages = deriveStages(row)
  const confidence = row.confidence === null ? null : Math.round(row.confidence * 100)
  return (
    <div className="run-canvas-inner">
      <header className="run-header">
        <div className="run-title-row"><div><div className="run-breadcrumb"><span>{sourceLabel(row.source)}</span><span>/</span><code>{row.sourceRef}</code></div><h2>{row.title || row.sourceRef}</h2></div><StatusBadge row={row} large /></div>
        <div className="run-meta"><SourceIcon source={row.source} /><span>{sourceLabel(row.source)}</span><span>·</span><span>@{row.actorHandle}</span><span>·</span><time dateTime={row.createdAt} suppressHydrationWarning>{relativeTime(row.createdAt)}</time></div>
      </header>
      <ol className="run-progress" aria-label="Run progress">
        {stages.map((stage, index) => <li key={stage.label} className={stage.state}><span className="progress-node" aria-hidden="true">{stage.state === 'complete' ? <CheckIcon /> : index + 1}</span><strong>{stage.label}</strong></li>)}
      </ol>
      <section className="activity-panel" aria-labelledby="activity-title">
        <header><div><i className="activity-pulse" /><h3 id="activity-title">Agent activity</h3></div><span>{row.ticketStatus ?? (row.outcome ? 'Decision complete' : 'Triage queued')}</span></header>
        <div className="activity-log">
          <LogLine time="now" status="success">Signal normalized from {sourceLabel(row.source)}</LogLine>
          <LogLine time="now" status={row.reasoning ? 'success' : 'active'}>{row.reasoning ? 'Context analysis complete' : 'Analyzing available context'}</LogLine>
          {row.reasoning ? <LogLine time="now" status="success">Decision generated at {confidence ?? 0}% confidence</LogLine> : null}
          {row.policyHits?.length ? <LogLine time="now" status="warning">Policy review: {row.policyHits.join(', ')}</LogLine> : null}
          {row.ticketStatus ? <LogLine time="now" status={row.prUrl ? 'success' : 'active'}>Build ticket {row.ticketStatus.toLowerCase()}</LogLine> : null}
          {row.prUrl ? <LogLine time="now" status="success">Pull request ready for review</LogLine> : null}
        </div>
      </section>
      <section className="run-summary">
        <div><span>Decision</span><strong>{row.outcome ? labelOutcome(row.outcome) : 'Pending'}</strong></div>
        <div><span>Confidence</span><strong>{confidence === null ? 'Not scored' : `${confidence}%`}</strong></div>
        <div><span>Evidence</span><strong>{row.citations?.length ?? 0} sources</strong></div>
        <div><span>Execution</span><strong>{row.ticketStatus ?? 'Not started'}</strong></div>
      </section>
      {row.needsReview ? <section className="approval-banner"><div className="approval-icon"><ShieldIcon /></div><div><strong>Approval required</strong><p>This decision is ready for a human check before execution continues.</p></div><Link href={`/events/${row.eventId}`}>Review &amp; decide <ArrowIcon /></Link></section> : <div className="run-footer-action"><span>{row.outcome ? 'Decision recorded in the ledger' : 'The agent will continue when analysis completes.'}</span><Link href={`/events/${row.eventId}`}>Open run <ArrowIcon /></Link></div>}
    </div>
  )
}

function RunInspector({ row }: { row: CommandCenterRow }) {
  const confidence = row.confidence === null ? null : Math.round(row.confidence * 100)
  return (
    <div className="run-inspector-inner">
      <section className="inspector-card decision-card">
        <div className="inspector-card-title"><h3>Decision</h3><StatusBadge row={row} /></div>
        <div className="confidence-value"><strong>{confidence === null ? '—' : (confidence / 100).toFixed(2)}</strong><span>{confidence === null ? 'Not scored' : confidence >= 80 ? 'High confidence' : 'Review advised'}</span></div>
        <div className="confidence-track"><i style={{ width: `${confidence ?? 0}%` }} /></div>
        <h4>Rationale</h4><p>{row.reasoning || 'The decision agent is still gathering enough context.'}</p>
      </section>
      <section className="inspector-card"><h3>Evidence</h3><InspectorRow icon={<ShieldIcon />} label={row.policyHits?.length ? `${row.policyHits.length} policy signal${row.policyHits.length === 1 ? '' : 's'}` : 'No blocking policy'} /><InspectorRow icon={<DocumentIcon />} label={`${row.citations?.length ?? 0} supporting reference${row.citations?.length === 1 ? '' : 's'}`} /><InspectorRow icon={<SourceIcon source={row.source} />} label={`${sourceLabel(row.source)} · ${row.sourceRef}`} /></section>
      <section className="inspector-card"><h3>Repository &amp; execution</h3><dl className="run-detail-list"><div><dt>Ticket</dt><dd>{row.ticketId ? 'Created' : 'Not created'}</dd></div><div><dt>Status</dt><dd>{row.ticketStatus ?? 'Waiting'}</dd></div><div><dt>Pull request</dt><dd>{row.prUrl ? <a href={row.prUrl} target="_blank" rel="noreferrer">Open PR <ArrowIcon /></a> : 'Not available'}</dd></div><div><dt>Actor</dt><dd>@{row.actorHandle}</dd></div></dl></section>
      <section className="inspector-card connection-card"><div><span className="connection-dot" /><div><strong>{sourceLabel(row.source)} connected</strong><small>Source context available to agents</small></div></div><Link href="/integrations">Manage</Link></section>
    </div>
  )
}

function InspectorRow({ icon, label }: { icon: React.ReactNode; label: string }) { return <div className="inspector-evidence-row"><span>{icon}</span><strong>{label}</strong><ArrowIcon /></div> }
function LogLine({ time, status, children }: { time: string; status: 'success' | 'active' | 'warning'; children: React.ReactNode }) { return <div className={`log-line is-${status}`}><time>{time}</time><span className="log-status">{status === 'success' ? <CheckIcon /> : <i />}</span><code>{children}</code></div> }

function StatusBadge({ row, large = false }: { row: CommandCenterRow; large?: boolean }) {
  const state = row.needsReview ? 'approval' : row.prUrl || row.ticketStatus === 'done' ? 'done' : row.ticketStatus ? 'running' : row.outcome ? 'decided' : 'queued'
  const label = state === 'approval' ? 'Approval required' : state === 'done' ? 'Completed' : state === 'running' ? 'Running' : state === 'decided' ? 'Decided' : 'Queued'
  return <span className={`command-status status-${state}${large ? ' is-large' : ''}`}><i />{label}</span>
}

function deriveStages(row: CommandCenterRow) {
  const current = row.prUrl ? 6 : row.needsReview ? 4 : row.ticketStatus ? 3 : row.outcome ? 2 : row.reasoning ? 1 : 0
  return ['Triage', 'Research', 'Plan', 'Code', 'Review', 'QA', 'Delivery'].map((label, index) => ({ label, state: index < current ? 'complete' : index === current ? 'active' : 'pending' }))
}

function EmptyRun() { return <div className="command-zero"><span><InboxIcon /></span><h2>Your command center is ready</h2><p>Connect a source to route real product signals through triage, planning, and execution.</p><Link href="/integrations">Connect accounts <ArrowIcon /></Link></div> }
function EmptyInspector() { return <div className="empty-run-inspector"><strong>No run selected</strong><span>Evidence and execution details will appear here.</span></div> }
function sourceLabel(source: string) { return ({ github: 'GitHub', slack: 'Slack', gmail: 'Gmail', gcal: 'Google Calendar', gdrive: 'Google Drive', granola: 'Granola', linear: 'Linear' } as Record<string, string>)[source.toLowerCase()] ?? source }
function labelOutcome(outcome: string) { return outcome.charAt(0) + outcome.slice(1).toLowerCase() }
function relativeTime(value: string) { const elapsed = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(elapsed / 60_000)); if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago` }
function SourceIcon({ source }: { source: string }) { if (source.toLowerCase().includes('github')) return <GitHubIcon />; if (source.toLowerCase().includes('slack')) return <SlackIcon />; return <InboxIcon /> }
function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.2" /><path d="m12.3 12.3 4.2 4.2" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.3 3.2 3.2L15.5 6" /></svg> }
function ArrowIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-4-4 4 4-4 4" /></svg> }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 3.6-2.3 6.3-6 8-3.7-1.7-6-4.4-6-8V5l6-2.5Z" /><path d="m7.5 10 1.7 1.7 3.6-3.8" /></svg> }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg> }
function InboxIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v11H3zM3 11h4l1.5 2h3l1.5-2h4" /></svg> }
function GitHubIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a7.5 7.5 0 0 0-2.37 14.62c.38.07.51-.16.51-.36v-1.47c-2.09.45-2.53-.89-2.53-.89-.34-.87-.84-1.1-.84-1.1-.68-.47.05-.46.05-.46.76.05 1.15.78 1.15.78.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.42-.83-3.42-3.71 0-.82.29-1.49.77-2.01-.08-.19-.33-.96.07-1.99 0 0 .63-.2 2.06.77A7.2 7.2 0 0 1 10 6.25c.64 0 1.28.09 1.88.25 1.43-.97 2.06-.77 2.06-.77.4 1.03.15 1.8.07 1.99.48.52.77 1.19.77 2.01 0 2.88-1.76 3.51-3.43 3.7.27.23.51.69.51 1.39v1.94c0 .2.14.44.52.36A7.5 7.5 0 0 0 10 2.5Z" /></svg> }
function SlackIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.3 2.5a1.8 1.8 0 1 1 0 3.6H5.5V4.3c0-1 .8-1.8 1.8-1.8Zm0 4.5c1 0 1.8.8 1.8 1.8v4.5a1.8 1.8 0 1 1-3.6 0V8.8C5.5 7.8 6.3 7 7.3 7Zm10.2 1.8a1.8 1.8 0 1 1-3.6 0V7h1.8c1 0 1.8.8 1.8 1.8Zm-4.5 0c0 1-.8 1.8-1.8 1.8H6.7a1.8 1.8 0 1 1 0-3.6h4.5c1 0 1.8.8 1.8 1.8Zm-1.8 8.7a1.8 1.8 0 1 1 0-3.6H13v1.8c0 1-.8 1.8-1.8 1.8Zm0-4.5c-1 0-1.8-.8-1.8-1.8V6.7a1.8 1.8 0 1 1 3.6 0v4.5c0 1-.8 1.8-1.8 1.8ZM2.5 11.2a1.8 1.8 0 1 1 3.6 0V13H4.3c-1 0-1.8-.8-1.8-1.8Zm4.5 0c0-1 .8-1.8 1.8-1.8h4.5a1.8 1.8 0 1 1 0 3.6H8.8c-1 0-1.8-.8-1.8-1.8Z" /></svg> }
