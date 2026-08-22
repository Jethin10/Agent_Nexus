'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TriageOutcome } from '@ascendant/core'
import { EventReviewActions } from '@/components/event-review-actions'

interface InboxRow {
  eventId: string
  source: string
  sourceRef: string
  title: string
  bodyPreview: string
  actorHandle: string
  createdAt: string
  outcome: string | null
  confidence: number | null
  reasoning: string | null
  citations: unknown[] | null
  prUrl: string | null
}

function useLocalInbox() {
  const [rows, setRows] = useState<InboxRow[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/local/inbox', { cache: 'no-store' })
      const body = await response.json() as { rows?: InboxRow[]; error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setRows(body.rows ?? [])
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 3_000)
    return () => window.clearInterval(timer)
  }, [load])
  return { rows, error, loading }
}

export function LocalInboxClient() {
  const { rows, error, loading } = useLocalInbox()
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? rows.filter((row) => `${row.title} ${row.sourceRef} ${row.reasoning ?? ''}`.toLowerCase().includes(needle)) : rows
  }, [query, rows])

  return (
    <div className="local-inbox">
      <header className="ledger-header">
        <div><span className="eyebrow">Live triage</span><h1>Triage inbox</h1><p>Signals update every three seconds while the workflow runs.</p></div>
        <span className="live-refresh"><i /> Live</span>
      </header>
      <input className="local-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search inbox" aria-label="Search inbox" />
      {error ? <p className="error">Could not load the inbox: {error}</p> : null}
      {loading ? <p className="dim">Loading persisted signals…</p> : null}
      <section className="ledger-list">
        {visible.map((row) => <SignalCard key={row.eventId} row={row} />)}
      </section>
    </div>
  )
}

export function LocalLedgerClient() {
  const { rows, error, loading } = useLocalInbox()
  const counts = rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.source]: (all[row.source] ?? 0) + 1 }), {})
  return (
    <div className="ledger-page">
      <header className="ledger-header">
        <div><span className="eyebrow">Immutable context</span><h1>Context ledger</h1><p>Emails, Slack conversations, meetings, and GitHub activity—alongside the analysis each signal produced.</p></div>
        <Link className="runtime-launch" href="/integrations">Sync sources</Link>
      </header>
      {error ? <p className="error">Could not load the ledger: {error}</p> : null}
      {loading ? <p className="dim">Loading source history…</p> : null}
      <section className="ledger-source-strip">{Object.entries(counts).map(([source, count]) => <div key={source}><strong>{count}</strong><span>{sourceLabel(source)}</span></div>)}</section>
      <section className="ledger-list">{rows.map((row) => <SignalCard key={row.eventId} row={row} ledger />)}</section>
    </div>
  )
}

function SignalCard({ row, ledger = false }: { row: InboxRow; ledger?: boolean }) {
  return (
    <article className="ledger-record">
      <div className="ledger-record-meta"><span className={`ledger-source source-${row.source}`}>{sourceLabel(row.source)}</span><span>@{row.actorHandle}</span><time>{new Date(row.createdAt).toLocaleString()}</time><code>{row.sourceRef}</code></div>
      <h2><Link href={`/events/${row.eventId}`}>{row.title || row.sourceRef}</Link></h2>
      {ledger ? <p className="ledger-body">{row.bodyPreview || '(empty source body)'}</p> : null}
      <div className="ledger-analysis"><span className={`ledger-outcome outcome-${row.outcome ?? 'pending'}`}>{row.outcome ?? 'CONTEXT'}</span><p>{row.reasoning || 'Stored as supporting context; no standalone decision was required.'}</p>{row.citations?.length ? <small>{row.citations.length} verified citation{row.citations.length === 1 ? '' : 's'}</small> : null}</div>
    </article>
  )
}

interface EventPayload {
  event: { id: string; title: string; source: string; sourceRef: string; actorHandle: string; body: string; createdAt: string }
  decision: { id: string; outcome: TriageOutcome; confidence: number; reasoning: string; citations: { ref: string; quote: string; why: string }[]; modelUsed: string } | null
  ticket: { status: string; prUrl?: string | null; prNumber?: number | null } | null
  conversation: { id: string; source: string; sourceRef: string; actorHandle: string; title: string; body: string; createdAt: string }[]
  timeline: { id: string; agent: string; phase: string; summary: string; at: string }[]
}

export function LocalEventClient({ id }: { id: string }) {
  const [payload, setPayload] = useState<EventPayload>()
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/local/events/${encodeURIComponent(id)}`, { cache: 'no-store' })
      const body = await response.json() as EventPayload & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setPayload(body)
      setError(undefined)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [id])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 3_000); return () => window.clearInterval(timer) }, [load])
  if (error) return <div className="ledger-page"><Link href="/">← Inbox</Link><p className="error">Could not load event: {error}</p></div>
  if (!payload) return <div className="ledger-page"><p className="dim">Loading event and analysis…</p></div>
  const { event, decision, ticket, conversation, timeline } = payload
  return (
    <div className="ledger-page local-event">
      <div className="row small"><Link href="/">← Inbox</Link><span className="live-refresh"><i /> Live</span></div>
      <h1>{event.title}</h1>
      <p className="dim mono">{sourceLabel(event.source)} · {event.sourceRef} · @{event.actorHandle}</p>
      <section className="panel"><h2>The decision</h2>{decision ? <><div className="row"><span className={`ledger-outcome outcome-${decision.outcome}`}>{decision.outcome}</span><strong>{Math.round(decision.confidence * 100)}% confidence</strong><code>{decision.modelUsed}</code></div><p>{decision.reasoning}</p><h3>Verified evidence</h3>{decision.citations.map((citation) => <blockquote key={citation.ref}><strong>{citation.ref}</strong><br />{citation.quote}<small>{citation.why}</small></blockquote>)}<div className="event-review-divider" /><EventReviewActions eventId={event.id} decisionId={decision.id} outcome={decision.outcome} /></> : <p className="dim">Analysis is queued.</p>}</section>
      {ticket ? <section className="panel"><h2>Build ticket</h2><p>{ticket.status}{ticket.prUrl ? <> · <a href={ticket.prUrl}>PR #{ticket.prNumber}</a></> : null}</p></section> : null}
      <section className="panel"><h2>Agent run</h2><div className="source-thread">{timeline.map((row) => <article key={row.id} className="source-thread-item"><div className="row small"><strong>{row.agent}</strong><code>{row.phase}</code><time>{new Date(row.at).toLocaleTimeString()}</time></div><p>{row.summary}</p></article>)}</div>{timeline.length === 0 ? <p className="dim">Waiting for workflow trace…</p> : null}</section>
      <section className="panel"><h2>Source conversation</h2><div className="source-thread">{conversation.map((message) => <article key={message.id} className="source-thread-item"><div className="row small"><span className="ledger-source">{sourceLabel(message.source)}</span><strong>@{message.actorHandle}</strong><time>{new Date(message.createdAt).toLocaleString()}</time></div><h3>{message.title}</h3><pre className="block small">{message.body}</pre></article>)}</div></section>
    </div>
  )
}

function sourceLabel(source: string) {
  return ({ github: 'GitHub', slack: 'Slack', gmail: 'Gmail', gcal: 'Google Calendar', gdrive: 'Google Drive', granola: 'Granola', linear: 'Linear' } as Record<string, string>)[source] ?? source
}
