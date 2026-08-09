'use client'

import { useEffect, useRef, useState } from 'react'

const SOURCES = [
  {
    name: 'Slack',
    location: '#customer-escalations',
    author: 'Maya · Support',
    message: 'Acme says sessions are expiring during checkout. Three reports this morning.',
    tone: 'slack',
  },
  {
    name: 'Discord',
    location: '#api-help',
    author: 'northern-labs',
    message: 'Seeing 401s after 15 minutes even though the docs promise a one-hour session.',
    tone: 'discord',
  },
  {
    name: 'GitHub',
    location: 'acme/api#1058',
    author: 'alexchen',
    message: 'Session TTL defaults to 900 seconds after the v2.4 migration.',
    tone: 'github',
  },
]

const PIPELINE = ['Listen', 'Correlate', 'Decide', 'Act']

type Resolution = 'approve' | 'clarify' | 'reject'

export function DemoJourney() {
  const [step, setStep] = useState(0)
  const [running, setRunning] = useState(false)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  function runDemo() {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setResolution(null)
    setStep(0)
    setRunning(true)
    ;[1, 2, 3].forEach((next, index) => {
      timers.current.push(setTimeout(() => {
        setStep(next)
        if (next === 3) setRunning(false)
      }, 950 + index * 1050))
    })
  }

  function resolve(next: Resolution) {
    setResolution(next)
    setStep(4)
  }

  function reset() {
    timers.current.forEach(clearTimeout)
    setRunning(false)
    setResolution(null)
    setStep(0)
  }

  return (
    <div className="demo-page">
      <header className="demo-hero">
        <div>
          <div className="demo-mode-line"><span /> Simulated replay · no credentials required</div>
          <h1>From scattered signals<br />to one defensible action.</h1>
          <p>Ascendant listens across the places your users already talk, connects the evidence, and gives your team a decision it can act on.</p>
        </div>
        <div className="demo-controls">
          <button className="demo-reset" type="button" onClick={reset}>Reset</button>
          <button className="demo-run" type="button" onClick={runDemo} disabled={running}>
            <PlayIcon /> {running ? 'Running replay…' : step === 0 ? 'Run 60-second demo' : 'Replay demo'}
          </button>
        </div>
      </header>

      <ol className="demo-pipeline" aria-label="Ascendant decision pipeline">
        {PIPELINE.map((label, index) => {
          const number = index + 1
          const active = step === number
          const complete = step > number
          return (
            <li key={label} className={active ? 'is-active' : complete ? 'is-complete' : ''}>
              <span>{complete ? <CheckIcon /> : number}</span>
              <div><strong>{label}</strong><small>{pipelineCopy(number)}</small></div>
            </li>
          )
        })}
      </ol>

      <div className="demo-stage" aria-live="polite">
        <section className="source-stream" aria-labelledby="source-stream-title">
          <div className="demo-section-heading">
            <div><h2 id="source-stream-title">Live source stream</h2><p>Normalized into one evidence model</p></div>
            <span className="stream-status"><i /> 3 sources connected</span>
          </div>
          <div className="source-list">
            {SOURCES.map((source, index) => (
              <article key={source.name} className={`source-message${step >= 1 ? ' is-visible' : ''}`} style={{ transitionDelay: `${index * 140}ms` }}>
                <SourceIcon tone={source.tone} label={source.name} />
                <div className="source-copy">
                  <div><strong>{source.author}</strong><span>{source.location}</span></div>
                  <p>{source.message}</p>
                </div>
                <span className="source-time">now</span>
              </article>
            ))}
          </div>
          {step === 0 && <div className="source-waiting"><WaveIcon /><span>Waiting for the replay</span></div>}
        </section>

        <section className={`decision-canvas${step >= 2 ? ' has-case' : ''}`} aria-labelledby="decision-title">
          {step < 2 ? (
            <div className="decision-idle">
              <AscendantMark />
              <h2 id="decision-title">Evidence will converge here</h2>
              <p>Run the demo to watch separate conversations become one decision.</p>
            </div>
          ) : (
            <>
              <div className="case-header">
                <div>
                  <span className="case-id">ASC-284</span>
                  <h2 id="decision-title">Restore the documented session timeout</h2>
                  <p>Three independent signals describe the same regression after v2.4.</p>
                </div>
                <span className="confidence-ring">92<small>%</small></span>
              </div>

              <div className="case-reasoning">
                <div className="reason-row"><CheckIcon /><span><strong>Same failure mode</strong> across support and community reports</span></div>
                <div className="reason-row"><CheckIcon /><span><strong>Root cause located</strong> in the v2.4 migration default</span></div>
                <div className="reason-row"><ShieldIcon /><span><strong>Policy requires review</strong> because authentication behavior changes</span></div>
              </div>

              {step === 2 && <div className="agent-thinking"><span /><strong>Decision agent is testing evidence against policy…</strong></div>}

              {step >= 3 && step < 4 && (
                <div className="human-gate">
                  <div><span>Human checkpoint</span><strong>Approve the recommended fix?</strong></div>
                  <p>Change the default TTL from 15 minutes to the documented 60 minutes and add a migration regression test.</p>
                  <div className="review-actions">
                    <button type="button" onClick={() => resolve('approve')} className="approve-action">Approve & dispatch</button>
                    <button type="button" onClick={() => resolve('clarify')}>Ask for context</button>
                    <button type="button" onClick={() => resolve('reject')}>Reject</button>
                  </div>
                </div>
              )}

              {step === 4 && resolution && <ActionReceipt resolution={resolution} />}
            </>
          )}
        </section>
      </div>

      <footer className="demo-proof">
        <span><LockIcon /> Demo data stays local</span>
        <span><ClockIcon /> Every decision is replayable</span>
        <span><AuditIcon /> Evidence and actions share one audit trail</span>
      </footer>
    </div>
  )
}

function pipelineCopy(step: number) {
  return ['Capture source context', 'Find one underlying need', 'Apply evidence + policy', 'Notify and create work'][step - 1]
}

function ActionReceipt({ resolution }: { resolution: Resolution }) {
  if (resolution !== 'approve') {
    return <div className="action-receipt neutral"><CheckIcon /><div><strong>{resolution === 'clarify' ? 'Context requested' : 'Recommendation rejected'}</strong><p>The source threads and audit log were updated. Nothing was dispatched.</p></div></div>
  }
  return (
    <div className="dispatch-result">
      <div className="dispatch-heading"><span className="success-mark"><CheckIcon /></span><div><strong>Decision dispatched</strong><p>Every team now sees the same outcome.</p></div></div>
      <div className="dispatch-list">
        <div><SourceIcon tone="linear" label="Linear" /><span><strong>ASC-284 created</strong><small>Assigned to Platform · P1</small></span><CheckIcon /></div>
        <div><SourceIcon tone="slack" label="Slack" /><span><strong>Support thread updated</strong><small>Decision + owner shared</small></span><CheckIcon /></div>
        <div><SourceIcon tone="discord" label="Discord" /><span><strong>Community reply drafted</strong><small>Clear status without internal detail</small></span><CheckIcon /></div>
        <div><AuditIcon /><span><strong>Audit record sealed</strong><small>Evidence, policy, actor, and time</small></span><CheckIcon /></div>
      </div>
    </div>
  )
}

function SourceIcon({ tone, label }: { tone: string; label: string }) {
  return <span className={`demo-source-icon tone-${tone}`} aria-label={label}>{label.slice(0, 1)}</span>
}

function PlayIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5.8 6.5 4.2-6.5 4.2z" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.2 3.1 3.1L15 6.7" /></svg> }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 3.6-2.3 6.3-6 8-3.7-1.7-6-4.4-6-8V5zM7.4 10l1.7 1.7 3.7-4" /></svg> }
function LockIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="8.5" width="11" height="8" rx="2" /><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5" /></svg> }
function ClockIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 6v4.5l3 1.5" /></svg> }
function AuditIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg> }
function WaveIcon() { return <svg viewBox="0 0 64 28" aria-hidden="true"><path d="M2 14h8l4-9 7 18 7-14 6 10 6-5h8l5-8 7 8h2" /></svg> }
function AscendantMark() { return <div className="ascendant-orbit"><span>A</span><i /><i /></div> }
