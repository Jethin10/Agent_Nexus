import type { AgentEventRow } from '@ascendant/db'
import { Pill } from './bits'

/**
 * The debate, rendered as a structured thread rather than a wall of scrolling text.
 * §16 beat 3 depends on this being legible: Planner's plan, Reviewer's objections with
 * severities, Planner's revision, Coder's diff, Reviewer's line comment, Coder's fix,
 * QA going red then green.
 *
 * Reads `agent_events`, which is permanent — Inngest Free retains traces 24h and Vercel
 * Hobby logs 1h, so a Friday run would be invisible on Sunday without this table.
 */
const AGENT_COLOR: Record<string, string> = {
  triage: 'var(--escalate)',
  planner: 'var(--merge)',
  coder: 'var(--accept)',
  reviewer: 'var(--defer)',
  qa: 'var(--reject)',
  delivery: 'var(--accept)',
  router: 'var(--dim)',
  orchestrator: 'var(--dim)',
  research: 'var(--merge)',
}

export function Timeline({ rows }: { rows: readonly AgentEventRow[] }) {
  const t0 = rows[0]?.at.getTime() ?? 0

  return (
    <div className="tl">
      {rows.map((r) => (
        <div className="tl-item" key={r.id}>
          <div className="row small">
            <span className="tl-agent" style={{ color: AGENT_COLOR[r.agent] ?? 'var(--text)' }}>
              {r.agent}
            </span>
            <span className="dim mono">{r.phase}</span>
            {r.round !== null && <Pill>round {r.round}</Pill>}
            <span style={{ flex: 1 }} />
            {r.model && <span className="dim mono">{r.model}</span>}
            {r.tokens > 0 && <span className="dim mono">{r.tokens} tok</span>}
            {r.latencyMs > 0 && <span className="dim mono">{r.latencyMs}ms</span>}
            <span className="dim mono">+{Math.round((r.at.getTime() - t0) / 100) / 10}s</span>
          </div>
          <div style={{ marginTop: 3 }}>{r.summary}</div>
          {r.detail ? <Detail detail={r.detail} /> : null}
        </div>
      ))}
    </div>
  )
}

/**
 * Renders the handful of `detail` shapes that carry the story, and falls back to JSON
 * for everything else. Blobs never appear here — they go to `artifacts` and are
 * referenced by id (R2), so `detail` is always small enough to print.
 */
function Detail({ detail }: { detail: Record<string, unknown> }) {
  const d = detail as {
    components?: { modelSelfReport: number; evidenceStrength: number; policyAgreement: number }
    bandApplied?: string[]
    citedRefs?: string[]
    fabricatedRefs?: string[]
    candidatesSeen?: number
    bySource?: Record<string, number>
    degraded?: string[]
    findings?: { rule: string; severity: string; path: string; why: string }[]
    filesTouched?: string[]
    rules?: (string | undefined)[]
    failures?: string[]
    flaky?: string[]
    blocked?: string[]
    risks?: { risk: string; level: string }[]
    prUrl?: string
    attempts?: { model: string; reason: string }[]
  }

  const bits: React.ReactNode[] = []

  if (d.bySource) {
    bits.push(
      <span key="src">
        retrieval:{' '}
        {Object.entries(d.bySource)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k} ${n}`)
          .join(' · ') || 'nothing found'}
      </span>,
    )
  }
  if (d.degraded?.length) {
    bits.push(
      <span key="deg" style={{ color: 'var(--defer)' }}>
        degraded: {d.degraded.join(', ')}
      </span>,
    )
  }
  if (d.candidatesSeen !== undefined) {
    bits.push(<span key="cand">{d.candidatesSeen} candidates compared</span>)
  }
  if (d.citedRefs?.length) {
    bits.push(<span key="cited">cited {d.citedRefs.join(', ')}</span>)
  }
  if (d.fabricatedRefs?.length) {
    bits.push(
      <span key="fab" style={{ color: 'var(--reject)' }}>
        fabricated refs rejected: {d.fabricatedRefs.join(', ')}
      </span>,
    )
  }
  if (d.bandApplied?.length) {
    bits.push(<span key="band">band rules: {d.bandApplied.join(', ')}</span>)
  }
  if (d.filesTouched?.length) {
    bits.push(<span key="files">{d.filesTouched.join(', ')}</span>)
  }
  if (d.rules?.filter(Boolean).length) {
    bits.push(<span key="rules">objections: {d.rules.filter(Boolean).join(', ')}</span>)
  }
  if (d.failures?.length) {
    bits.push(
      <span key="fail" style={{ color: 'var(--reject)' }}>
        failing: {d.failures.join(', ')}
      </span>,
    )
  }
  if (d.flaky?.length) {
    bits.push(<span key="flaky">flaky (not counted as failures): {d.flaky.join(', ')}</span>)
  }
  if (d.attempts?.length) {
    bits.push(<span key="att">tried {d.attempts.map((a) => a.model).join(' → ')}</span>)
  }
  if (d.prUrl) {
    bits.push(
      <a key="pr" href={d.prUrl} target="_blank" rel="noreferrer">
        {d.prUrl}
      </a>,
    )
  }

  const components = d.components
  if (components) {
    bits.push(
      <span key="conf" className="mono">
        self {components.modelSelfReport.toFixed(2)} · evidence{' '}
        {components.evidenceStrength.toFixed(2)} · rules {components.policyAgreement.toFixed(2)}
      </span>,
    )
  }

  return (
    <>
      {bits.length > 0 && (
        <div className="row small dim" style={{ marginTop: 5 }}>
          {bits}
        </div>
      )}
      {d.findings?.length ? (
        <div style={{ marginTop: 6 }}>
          {d.findings.map((f, i) => (
            <div key={`${f.rule}-${i}`} className="small" style={{ color: 'var(--reject)' }}>
              <strong>[{f.severity}] {f.rule}</strong> <span className="mono">{f.path}</span> —{' '}
              <span className="muted">{f.why}</span>
            </div>
          ))}
        </div>
      ) : null}
      {d.risks?.length ? (
        <div style={{ marginTop: 6 }}>
          {d.risks.map((r, i) => (
            <div key={i} className="small muted">
              <Pill>{r.level}</Pill> {r.risk}
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
