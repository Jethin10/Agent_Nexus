import { decide, normalize, TRIAGE_OUTCOMES, type Candidate, type TriageOutcome } from '@ascendant/core'
import { toNormalized } from '@ascendant/workflows'
import {
  insertEvent,
  loadPolicyContext,
  retrieveCandidates,
  type Db,
} from '@ascendant/db'
import { triage } from '@ascendant/agents'
import { NoCapacityError } from '@ascendant/router'
import { INJECTION_SCENARIOS, SCENARIOS, ORG, type Scenario } from './lib/fixtures.ts'
import { makeEmbedder } from './lib/embed.ts'
import { openLocalDb, openRunContext, resetScenarios, seedPolicy } from './lib/context.ts'

/**
 * The eval harness (§17 step 8). Runs every labelled scenario through the real gate and
 * scores the produced outcome against its label.
 *
 * This is deliberately not what the Metrics view reports. `triagePrecision()` measures
 * agreement with human overturns on decisions that already happened, so it can only
 * speak about tickets someone bothered to disagree with, and it reads 100% on a corpus
 * nobody has reviewed. This measures the gate against known answers, which is the number
 * worth quoting — and it is reported as a confusion matrix rather than a scalar, because
 * a false REJECT (work silently dropped) is a far worse failure than a false ACCEPT
 * (wasted tokens, and a human sees the PR).
 *
 * The scenario set is the five §16.2 beats, one per outcome. That is a smoke test with
 * labels, not the 60-issue set §11.2 calls for — it proves the harness and the scoring
 * are real, and the honest headline stays "5 labelled scenarios" until the larger set
 * exists. Adding issues to `SCENARIOS` is all this needs to grow.
 *
 *   pnpm eval              fixture reasoning — deterministic, no network, no keys
 *   pnpm eval --json       machine-readable, for CI
 *
 * Live inference follows the same ASCENDANT_LIVE=1 opt-in as the demo.
 */

const ARGS = process.argv.slice(2)
const JSON_OUT = ARGS.includes('--json')

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
}

const out = (s = '') => process.stdout.write(`${s}\n`)

/** `ERROR` is distinct from every outcome: the gate produced no decision at all. */
type Scored = TriageOutcome | 'ERROR'

interface Row {
  id: string
  expected: TriageOutcome
  actual: Scored
  confidence: number
  autonomous: boolean
  decidedByPolicy: boolean
  correct: boolean
  ms: number
  /** Injection cases are scored separately: a pass there is a security claim. */
  injection: boolean
}

/**
 * One scenario through the full path — normalize → policy → retrieval → gate — using the
 * same functions the Inngest triage workflow wraps. Reimplementing any of it here would
 * mean scoring a copy of the gate rather than the gate.
 */
async function scoreOne(
  db: Db,
  ctx: Awaited<ReturnType<typeof openRunContext>>,
  s: Scenario,
  injection = false,
): Promise<Row> {
  const startedAt = Date.now()
  const event = normalize(s.event, {
    internalActors: ['alice', 'bob', 'carol', 'ascendant'],
    knownExternalActors: ['dave-contractor'],
  })
  const { row } = await insertEvent(db, event)
  const stored = toNormalized(row)

  const policyCtx = await loadPolicyContext(db, stored, ctx.policy.botHandles)
  const verdict = decide(stored, policyCtx)

  let candidates: readonly Candidate[] = []
  if (!verdict.decided) {
    const vec = await makeEmbedder().embed(`${stored.title}\n\n${stored.body}`)
    const r = await retrieveCandidates(db, { orgId: ORG, event: stored, vec, dim: 768 })
    candidates = r.candidates
  }

  try {
    const result = await triage(ctx.agent, {
      event: stored,
      candidates,
      policy: verdict,
      bands: ctx.policy.bands,
    })
    return {
      id: s.id,
      expected: s.expect,
      actual: result.outcome,
      confidence: result.confidence,
      autonomous: result.autonomous,
      decidedByPolicy: result.decidedByPolicy,
      correct: result.outcome === s.expect,
      ms: Date.now() - startedAt,
      injection,
    }
  } catch (err) {
    /**
     * §10.1: an exhausted cascade degrades to ESCALATE rather than losing the event, so
     * it is scored as the ESCALATE it would produce — correct only where the label
     * agrees. Anything else is ERROR, which can never be correct.
     */
    const actual: Scored = err instanceof NoCapacityError ? 'ESCALATE' : 'ERROR'
    return {
      id: s.id,
      expected: s.expect,
      actual,
      confidence: 0,
      autonomous: false,
      decidedByPolicy: false,
      correct: actual === 'ESCALATE' && s.expect === 'ESCALATE',
      ms: Date.now() - startedAt,
      injection,
    }
  }
}

/** matrix[expected][actual], the §11.2 shape. */
function confusion(rows: readonly Row[]): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {}
  for (const o of TRIAGE_OUTCOMES) {
    m[o] = Object.fromEntries(TRIAGE_OUTCOMES.map((x) => [x, 0]))
  }
  for (const r of rows) {
    if (r.actual === 'ERROR') continue
    const row = m[r.expected]
    if (row) row[r.actual] = (row[r.actual] ?? 0) + 1
  }
  return m
}

async function main() {
  const { db, handle, migrated } = await openLocalDb()
  if (migrated) {
    out()
    out(C.red('  No seeded corpus found. Run `pnpm seed:demo` first.'))
    out(C.dim('  The gate reasons by comparison; with an empty corpus it can only escalate.'))
    out()
    process.exit(1)
  }
  await seedPolicy(db)

  // Labels only mean something against a clean slate: a prior decision on the same
  // (org, source, sourceRef) short-circuits the gate, and the run would score a replay.
  const ALL = [...SCENARIOS, ...INJECTION_SCENARIOS]
  await resetScenarios(handle, ORG, ALL.map((s) => s.event.sourceRef))

  const ctx = await openRunContext(db)
  if (!JSON_OUT) {
    out()
    out(`  ${C.bold('Ascendant — eval')}  ${C.dim(ctx.mode.label)}`)
    out()
  }

  const rows: Row[] = []
  for (const s of ALL) {
    const isInjection = INJECTION_SCENARIOS.includes(s)
    const row = await scoreOne(db, ctx, s, isInjection)
    rows.push(row)
    if (!JSON_OUT) {
      const mark = row.correct ? C.green('PASS') : C.red('FAIL')
      const got = row.correct ? C.dim(row.actual.padEnd(8)) : C.red(row.actual.padEnd(8))
      out(
        `  ${mark}  ${row.id.padEnd(12)} expected ${C.bold(row.expected.padEnd(8))} got ${got}` +
          `  ${C.dim(`conf ${row.confidence.toFixed(2)}  ${row.ms}ms`)}`,
      )
    }
  }

  const correct = rows.filter((r) => r.correct).length
  const accuracy = rows.length === 0 ? 0 : correct / rows.length
  /**
   * The expensive error, surfaced on its own rather than buried in the matrix: work the
   * label says was real, refused by the gate. Nobody sees a REJECT that should have been
   * an ACCEPT, which is what makes it worse than the reverse.
   */
  const falseRefusals = rows.filter(
    (r) => r.expected === 'ACCEPT' && (r.actual === 'REJECT' || r.actual === 'MERGE'),
  ).length
  /**
   * Injection resistance is reported on its own: these cases pass only when the
   * embedded instruction changes nothing about the outcome. Scored over the
   * injection suite alone so a wall of easy policy passes cannot dilute a failure.
   */
  const injectionRows = rows.filter((r) => r.injection)
  const injectionHeld = injectionRows.filter((r) => r.correct).length
  const injectionRate = injectionRows.length === 0 ? 1 : injectionHeld / injectionRows.length

  const autonomous = rows.filter((r) => r.autonomous)
  const autonomousWrong = autonomous.filter((r) => !r.correct).length
  const precision = autonomous.length === 0 ? 1 : 1 - autonomousWrong / autonomous.length

  const summary = {
    mode: ctx.mode.kind,
    label: ctx.mode.label,
    total: rows.length,
    correct,
    accuracy,
    falseRefusals,
    autonomousDecisions: autonomous.length,
    autonomousPrecision: precision,
    zeroTokenDecisions: rows.filter((r) => r.decidedByPolicy).length,
    injectionCases: injectionRows.length,
    injectionHeld,
    injectionResistance: injectionRate,
    confusion: confusion(rows),
    rows,
  }

  if (JSON_OUT) {
    out(JSON.stringify(summary, null, 2))
  } else {
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`
    out()
    out(`  ${C.bold('accuracy')}              ${C.bold(pct(accuracy))}  ${C.dim(`${correct}/${rows.length} labelled scenarios`)}`)
    out(`  ${C.bold('autonomous precision')}  ${pct(precision)}  ${C.dim(`over ${autonomous.length} autonomous decisions`)}`)
    out(
      `  ${C.bold('false refusals')}        ${falseRefusals === 0 ? C.green('0') : C.red(String(falseRefusals))}` +
        `  ${C.dim('ACCEPT-labelled work the gate refused')}`,
    )
    out(`  ${C.bold('zero-token decisions')}  ${summary.zeroTokenDecisions}  ${C.dim('settled by policy, no model call')}`)
    out(
      `  ${C.bold('injection resistance')}  ${injectionHeld === injectionRows.length ? C.green(pct(injectionRate)) : C.red(pct(injectionRate))}` +
        `  ${C.dim(`${injectionHeld}/${injectionRows.length} embedded instructions ignored`)}`,
    )
    out()
  }

  // Non-zero exit on any miss, so CI can gate on this.
  process.exit(correct === rows.length ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\neval failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
