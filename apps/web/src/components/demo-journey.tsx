'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

type Outcome = 'ACCEPT' | 'REJECT' | 'MERGE' | 'DEFER' | 'ESCALATE'

export interface DemoCase {
  eventId: string
  decisionId: string
  sourceRef: string
  title: string
  outcome: Outcome
  confidence: number
  reasoning: string
  citations: { kind: string; ref: string; quote: string; why: string }[]
  policyHits: string[]
  autonomous: boolean
  modelUsed: string
  ticketId: string | null
  ticketStatus: string | null
  prUrl: string | null
}

export interface IntegrationState {
  name: string
  ready: boolean
  detail: string
}

const OUTCOME_COPY: Record<Outcome, { verb: string; description: string }> = {
  REJECT: { verb: 'Decline', description: 'Evidence proves this work should not be done.' },
  MERGE: { verb: 'Consolidate', description: 'The same work already has an owner and a thread.' },
  DEFER: { verb: 'Ask', description: 'Specific missing context is requested before anyone guesses.' },
  ESCALATE: { verb: 'Route', description: 'Confidence or consequence requires a human judgement.' },
  ACCEPT: { verb: 'Build', description: 'Only verified, bounded work enters the engineering pipeline.' },
}

export function DemoJourney({ cases, integrations }: { cases: DemoCase[]; integrations: IntegrationState[] }) {
  const [selected, setSelected] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  function play() {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setPlaying(true)
    cases.forEach((_, index) => {
      timers.current.push(setTimeout(() => {
        setSelected(index)
        if (index === cases.length - 1) setPlaying(false)
      }, index * 1800))
    })
  }

  const current = cases[selected]
  const readyCount = integrations.filter((integration) => integration.ready).length

  return (
    <div className="demo-page demo-product">
      <header className="demo-hero">
        <div>
          <div className="demo-mode-line"><span /> Persisted product data · not a UI simulation</div>
          <h1>The decision layer<br />before code.</h1>
          <p>
            Coding agents make implementation cheap. Ascendant prevents that leverage from
            being spent on duplicates, guesses, and work the team already decided against.
          </p>
        </div>
        <div className="demo-controls">
          <Link className="demo-reset" href="/">Open inbox</Link>
          <button className="demo-run" type="button" onClick={play} disabled={playing || cases.length === 0}>
            <PlayIcon /> {playing ? 'Walking the decisions…' : 'Play persisted walkthrough'}
          </button>
        </div>
      </header>

      <section className="demo-thesis" aria-label="Product thesis">
        <div><span>01</span><strong>Retrieve before judging</strong><small>Four evidence sources, unioned and bounded.</small></div>
        <div><span>02</span><strong>Refuse by default</strong><small>Four of five valid outcomes create no coding work.</small></div>
        <div><span>03</span><strong>Build behind a gate</strong><small>ACCEPT is the only database-enforced path to a ticket.</small></div>
      </section>

      {current ? (
        <div className="demo-stage demo-real-stage">
          <aside className="decision-index" aria-label="Persisted demo decisions">
            <div className="demo-section-heading">
              <div><h2>Five outcomes</h2><p>Each row was produced by the real gate</p></div>
              <span className="stream-status"><i /> {cases.length}/5 loaded</span>
            </div>
            <div className="decision-index-list">
              {cases.map((item, index) => (
                <button
                  key={item.decisionId}
                  type="button"
                  className={index === selected ? 'is-selected' : ''}
                  onClick={() => { setPlaying(false); setSelected(index) }}
                >
                  <span className={`outcome-glyph outcome-${item.outcome}`}>{index + 1}</span>
                  <span><strong>{item.outcome}</strong><small>{OUTCOME_COPY[item.outcome].verb} · {item.title}</small></span>
                  <b>{Math.round(item.confidence * 100)}</b>
                </button>
              ))}
            </div>
            <div className="integration-readiness">
              <div><span>Connected for this process</span><strong>{readyCount}/{integrations.length}</strong></div>
              {integrations.map((integration) => (
                <p key={integration.name} className={integration.ready ? 'is-ready' : ''}>
                  <i /> <b>{integration.name}</b><span>{integration.ready ? integration.detail : 'not configured'}</span>
                </p>
              ))}
            </div>
          </aside>

          <article className="decision-dossier" key={current.decisionId}>
            <div className="dossier-kicker">
              <span className={`outcome-chip outcome-${current.outcome}`}>{current.outcome}</span>
              <span>{current.sourceRef}</span>
              <span>{current.autonomous ? 'autonomous' : 'human boundary applied'}</span>
            </div>
            <div className="case-header">
              <div>
                <span className="case-id">DECISION {current.decisionId.slice(0, 8).toUpperCase()}</span>
                <h2>{current.title}</h2>
                <p>{OUTCOME_COPY[current.outcome].description}</p>
              </div>
              <span className={`confidence-ring outcome-${current.outcome}`}>
                {Math.round(current.confidence * 100)}<small>%</small>
              </span>
            </div>

            <section className="dossier-reasoning">
              <span>Decision rationale</span>
              <p>{current.reasoning}</p>
            </section>

            <div className="dossier-grid">
              <section>
                <div className="dossier-heading"><span>Verified evidence</span><b>{current.citations.length}</b></div>
                {current.citations.map((citation) => (
                  <blockquote key={`${citation.ref}-${citation.quote}`}>
                    <div><EvidenceIcon /><strong>{citation.ref}</strong><small>{citation.kind}</small></div>
                    <p>“{citation.quote}”</p>
                  </blockquote>
                ))}
              </section>
              <section>
                <div className="dossier-heading"><span>Execution receipt</span><b>live row</b></div>
                <dl className="execution-receipt">
                  <div><dt>Reasoning source</dt><dd>{current.modelUsed.startsWith('fixture:') ? 'Validated fixture' : current.modelUsed}</dd></div>
                  <div><dt>Policy</dt><dd>{current.policyHits.length ? current.policyHits.join(', ') : 'No decisive rule'}</dd></div>
                  <div><dt>Work created</dt><dd>{current.ticketId ? current.ticketStatus || 'ticket opened' : 'None'}</dd></div>
                  <div><dt>Publication</dt><dd>{current.prUrl ? 'GitHub PR' : 'Not published'}</dd></div>
                </dl>
              </section>
            </div>

            <footer className="dossier-actions">
              <div><LockIcon /><span><strong>Immutable decision</strong><small>Corrections are stored as overturns, never edits.</small></span></div>
              <Link href={`/events/${current.eventId}`}>Open audit timeline <span>↗</span></Link>
              {current.prUrl && <a href={current.prUrl} target="_blank" rel="noreferrer">View pull request <span>↗</span></a>}
            </footer>
          </article>
        </div>
      ) : (
        <section className="demo-empty-state">
          <AscendantMark />
          <span>Demo corpus not prepared</span>
          <h2>Load decisions from the real gate.</h2>
          <p>Run the two commands below, then refresh. No cloud database, Docker, or credentials are required.</p>
          <pre>pnpm seed:demo{`\n`}pnpm demo</pre>
        </section>
      )}

      <footer className="demo-proof">
        <span><DatabaseIcon /> Real Postgres + pgvector path</span>
        <span><AuditIcon /> Verified citations and immutable decisions</span>
        <span><ShieldIcon /> No auto-merge, ever</span>
      </footer>
    </div>
  )
}

function PlayIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5.8 6.5 4.2-6.5 4.2z" /></svg> }
function EvidenceIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg> }
function LockIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="8.5" width="11" height="8" rx="2" /><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5" /></svg> }
function DatabaseIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="5" rx="6" ry="2.5" /><path d="M4 5v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" /></svg> }
function AuditIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg> }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 3.6-2.3 6.3-6 8-3.7-1.7-6-4.4-6-8V5zM7.4 10l1.7 1.7 3.7-4" /></svg> }
function AscendantMark() { return <div className="ascendant-orbit"><span>A</span><i /><i /></div> }
