import { CONFIG_KEYS, db, listConfig, readPolicy } from '@ascendant/db'
import { CONFIDENCE, LIMITS } from '@ascendant/core'
import { DbError, Panel, Pill, when } from '@/components/bits'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'
import { PolicyField } from '@/components/policy-field'

/**
 * Policy — §11.1's fourth view, and the second half of §16 beat 4.
 *
 * Everything here is read from the `config` table with the constants in
 * `@ascendant/core` as defaults. Dragging the autonomy threshold from 0.80 to 0.95 and
 * re-running the same issue is what proves the confidence scoring is real machinery
 * rather than a displayed number — and that is only possible because nothing reads the
 * constants directly at decision time.
 */
export const dynamic = 'force-dynamic'

export default async function PolicyPage() {
  const orgId = currentOrgId()

  try {
    await ensureDb()
    const database = db()
    const [policy, rows] = await Promise.all([
      readPolicy(database, orgId),
      listConfig(database, orgId),
    ])

    const setKeys = new Set(rows.map((r) => r.key))
    const overridden = (key: string) => setKeys.has(key)

    return (
      <>
        <h1>Policy</h1>
        <p className="lede">
          Thresholds and budgets, live. These are read from the database on every decision,
          not compiled in — so a change here takes effect on the next event without a
          deploy.
        </p>

        <Panel title="Autonomy bands">
          <p className="small dim" style={{ marginTop: 0 }}>
            confidence = 0.5 × the model&apos;s self-report + 0.3 × evidence strength + 0.2 ×
            whether the deterministic rules agree. At or above the autonomy threshold the
            gate acts alone; between the two it acts but flags for review; below the review
            floor it escalates and does nothing.
          </p>
          <PolicyField
            field="autonomous"
            label="Autonomy threshold"
            value={policy.bands.autonomous}
            step={0.01}
            fallback={CONFIDENCE.AUTONOMOUS}
            overridden={overridden(CONFIG_KEYS.autonomous)}
            help="At or above this, the gate acts with no human in the loop."
          />
          <PolicyField
            field="flagged"
            label="Review floor"
            value={policy.bands.flagged}
            step={0.01}
            fallback={CONFIDENCE.FLAGGED}
            overridden={overridden(CONFIG_KEYS.flagged)}
            help="Below this, the outcome is rewritten to ESCALATE and nothing is acted on."
          />
          <PolicyField
            field="injectionCeiling"
            label="Injection ceiling"
            value={policy.bands.injectionCeiling}
            step={0.01}
            fallback={CONFIDENCE.INJECTION_CEILING}
            overridden={overridden(CONFIG_KEYS.injectionCeiling)}
            help="A prompt-guard hit caps confidence here, which forces ESCALATE however sure the model was."
          />
        </Panel>

        <Panel title="Budgets">
          <p className="small dim" style={{ marginTop: 0 }}>
            Checked before every model call and decremented after. Exceeding a ceiling is an
            ESCALATE with the transcript attached, never a half-finished pull request. The
            daily ceiling exists so a runaway loop at 2am cannot leave the demo without
            quota at 10am.
          </p>
          <PolicyField
            field="ticketTokens"
            label="Per-ticket tokens"
            value={policy.ticketTokens}
            step={1000}
            fallback={LIMITS.MAX_TICKET_TOKENS}
            overridden={overridden(CONFIG_KEYS.ticketTokens)}
          />
          <PolicyField
            field="ticketLlmCalls"
            label="Per-ticket model calls"
            value={policy.ticketLlmCalls}
            step={1}
            fallback={LIMITS.MAX_TICKET_LLM_CALLS}
            overridden={overridden(CONFIG_KEYS.ticketLlmCalls)}
          />
          <PolicyField
            field="orgDailyTokens"
            label="Daily org tokens"
            value={policy.orgDailyTokens}
            step={10_000}
            fallback={LIMITS.MAX_ORG_DAILY_TOKENS}
            overridden={overridden(CONFIG_KEYS.orgDailyTokens)}
          />
        </Panel>

        <Panel title="Enforced in code, not configurable">
          <p className="small dim" style={{ marginTop: 0 }}>
            These are deliberately not editable here. A defence that can be turned off from
            a web form is not a defence — §15.3 layer 3 is capability, not persuasion.
          </p>
          <table>
            <tbody>
              <tr>
                <td>Blocked write paths</td>
                <td className="mono small muted">
                  .github/ · CI config · lockfiles · .env* · secrets patterns
                </td>
              </tr>
              <tr>
                <td>Auto-merge</td>
                <td className="muted small">
                  Never. A human approves every merge, at any confidence.
                </td>
              </tr>
              <tr>
                <td>Anonymous autonomy ceiling</td>
                <td className="muted small">
                  Triage and a draft PR, never an autonomous close.
                </td>
              </tr>
              <tr>
                <td>Test erosion</td>
                <td className="muted small">
                  Any diff reducing test count or assertions is rejected deterministically.
                </td>
              </tr>
              <tr>
                <td>Sandbox egress</td>
                <td className="muted small">
                  Package registry only. No access to the database, Inngest, or the GitHub
                  API.
                </td>
              </tr>
              <tr>
                <td>Debate caps</td>
                <td className="mono small muted">
                  {LIMITS.MAX_DEBATE_ROUNDS} rounds · {LIMITS.MAX_CODER_RETRIES} coder retries
                  · {LIMITS.MAX_FILES_TOUCHED} files · {LIMITS.MAX_DIFF_LINES} diff lines
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>

        {rows.length > 0 && (
          <Panel title="Change log">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Note</th>
                  <th>By</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono small">{r.key}</td>
                    <td className="mono small">{JSON.stringify(r.value)}</td>
                    <td className="small muted">{r.note ?? '—'}</td>
                    <td className="small dim">{r.updatedBy ?? '—'}</td>
                    <td className="small dim mono">{when(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <p className="small dim">
          <Pill flag>no auth</Pill> This view has no session check yet, so anyone who can
          reach this URL can change these values. That is the first thing to fix before this
          is exposed beyond a demo.
        </p>
      </>
    )
  } catch (err) {
    return (
      <>
        <h1>Policy</h1>
        <DbError error={err} />
      </>
    )
  }
}
