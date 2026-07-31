import { TriageOutcome } from '@ascendant/core'
import { db, dashboardMetrics, eventCounts, outcomeCounts, spendToday, triagePrecision } from '@ascendant/db'
import { DbError, Empty, Panel } from '@/components/bits'
import { currentOrgId } from '@/lib/org'
import { Matrix } from '@/components/matrix'

/**
 * Metrics — §11.1's third view, and §16 beat 4's first half.
 *
 * The headline is triage precision reported as a **confusion matrix over the five
 * outcomes**, not a scalar. A false REJECT means real work was silently dropped; a false
 * ACCEPT means wasted tokens and a human notices the PR. A single accuracy figure hides
 * exactly the error that matters most, so the matrix is the honest presentation and the
 * false-refusal cell is called out by name.
 */
export const dynamic = 'force-dynamic'

export default async function MetricsPage() {
  const orgId = currentOrgId()

  try {
    const database = db()
    const [precision, metrics, outcomes, sources, spend] = await Promise.all([
      triagePrecision(database, orgId),
      dashboardMetrics(database, orgId),
      outcomeCounts(database, orgId),
      eventCounts(database, orgId),
      spendToday(database, orgId),
    ])

    const total = outcomes.reduce((n, c) => n + c.n, 0)
    const refused = outcomes.filter((c) => c.outcome !== 'ACCEPT').reduce((n, c) => n + c.n, 0)

    return (
      <>
        <h1>Metrics</h1>
        <p className="lede">
          Read from Postgres, not from a vendor dashboard, so the history is permanent and
          this page works offline from a seeded database.
        </p>

        <div className="grid">
          <Panel title="Triage precision">
            <div className="stat">{(precision.precision * 100).toFixed(1)}%</div>
            <p className="small dim" style={{ margin: '2px 0 0' }}>
              1 − (overturns ÷ autonomous decisions). {precision.overturned} of{' '}
              {precision.autonomousDecisions} autonomous decisions were overturned.
            </p>
          </Panel>

          <Panel title="False refusals">
            <div className="stat" style={{ color: precision.falseRefusals > 0 ? 'var(--reject)' : undefined }}>
              {precision.falseRefusals}
            </div>
            <p className="small dim" style={{ margin: '2px 0 0' }}>
              REJECT or MERGE that a human turned into ACCEPT. The expensive error: real
              work the gate dropped.
            </p>
          </Panel>

          <Panel title="Refused before any code">
            <div className="stat">
              {refused}
              <span className="dim" style={{ fontSize: 15 }}> / {total}</span>
            </div>
            <p className="small dim" style={{ margin: '2px 0 0' }}>
              Four of the five outcomes are refusals. This is the number the pitch rests on.
            </p>
          </Panel>

          <Panel title="Cost today">
            <div className="stat">${'0.00'}</div>
            <p className="small dim" style={{ margin: '2px 0 0' }}>
              {spend.tokens.toLocaleString()} tokens · {spend.calls} model calls. Everything
              runs on free tiers; the binding constraint is Groq&apos;s requests-per-day.
            </p>
          </Panel>
        </div>

        <Panel title="Confusion matrix — predicted (rows) against what a human settled on (columns)">
          {precision.autonomousDecisions === 0 ? (
            <Empty>
              No autonomous decisions yet. Run <code>pnpm eval</code> against the 60-event
              labelled set to populate this.
            </Empty>
          ) : (
            <Matrix matrix={precision.matrix} />
          )}
          <p className="small dim" style={{ marginBottom: 0 }}>
            The diagonal is agreement. The cells that matter most are the REJECT and MERGE
            rows under the ACCEPT column — work the system refused that it should have done.
          </p>
        </Panel>

        <Panel title="Cycle time">
          {metrics.cycleTime.p50 ? (
            <div className="row">
              <span>
                <span className="stat">{Math.round(Number(metrics.cycleTime.p50) / 1000)}s</span>{' '}
                <span className="muted">median</span>
              </span>
              <span>
                <span className="stat">{Math.round(Number(metrics.cycleTime.p90) / 1000)}s</span>{' '}
                <span className="muted">p90</span>
              </span>
            </div>
          ) : (
            <Empty>No completed pipelines yet.</Empty>
          )}
        </Panel>

        <Panel title="Velocity — last 30 days">
          {metrics.velocity.length === 0 ? (
            <Empty>Nothing decided in the last 30 days.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Decisions</th>
                  <th className="num">Accepted</th>
                  <th className="num">Refused</th>
                </tr>
              </thead>
              <tbody>
                {metrics.velocity.map((d) => (
                  <tr key={d.day}>
                    <td className="mono">{d.day}</td>
                    <td className="num">{d.decisions}</td>
                    <td className="num" style={{ color: 'var(--accept)' }}>{d.accepted}</td>
                    <td className="num muted">{d.refused}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="grid">
          <Panel title="Outcomes">
            {outcomes.length === 0 ? (
              <Empty>No decisions yet.</Empty>
            ) : (
              <table>
                <tbody>
                  {TriageOutcome.options.map((o) => {
                    const hit = outcomes.find((c) => c.outcome === o)
                    return (
                      <tr key={o}>
                        <td>
                          <span className={`badge b-${o}`}>{o}</span>
                        </td>
                        <td className="num">{hit?.n ?? 0}</td>
                        <td className="num dim small">
                          {hit ? `${hit.autonomous} autonomous` : ''}
                        </td>
                        <td className="num dim small mono">
                          {hit?.avgConfidence ? Number(hit.avgConfidence).toFixed(2) : ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Events by source">
            {sources.length === 0 ? (
              <Empty>Nothing ingested yet.</Empty>
            ) : (
              <table>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.source}>
                      <td className="mono">{s.source}</td>
                      <td className="num">{s.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Delivery">
            {metrics.delivery.length === 0 ? (
              <Empty>No tickets yet.</Empty>
            ) : (
              <table>
                <tbody>
                  {metrics.delivery.map((d) => (
                    <tr key={d.status}>
                      <td className="mono">{d.status}</td>
                      <td className="num">{d.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </>
    )
  } catch (err) {
    return (
      <>
        <h1>Metrics</h1>
        <DbError error={err} />
      </>
    )
  }
}
