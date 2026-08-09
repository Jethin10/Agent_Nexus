import { decide, normalize, type Candidate } from '@ascendant/core'
import { toNormalized } from '@ascendant/workflows'
import {
  decisionForEvent,
  finishRun,
  insertDecision,
  insertEvent,
  loadPolicyContext,
  openTicketForAccept,
  retrieveCandidates,
  startRun,
  trace,
  type Db,
} from '@ascendant/db'
import { triage } from '@ascendant/agents'
import { NoCapacityError } from '@ascendant/router'
import { SCENARIOS, ORG, type Scenario } from './lib/fixtures.ts'
import { makeEmbedder } from './lib/embed.ts'
import { openLocalDb, openRunContext, resetScenarios, seedPolicy } from './lib/context.ts'

/**
 * Runs the five §16.2 demo scenarios through the real Triage Gate and narrates each
 * stage.
 *
 * This drives the same pure functions the Inngest functions wrap
 * (`packages/workflows/src/triage.ts`), in the same order, against the same database.
 * What it deliberately does not do is reimplement any of the reasoning: `decide`,
 * `retrieveCandidates`, `triage`, `insertDecision` and `openTicketForAccept` are all
 * the production code paths. The value of running it outside Inngest is only that it
 * needs no durable-execution service to watch it work.
 *
 *   pnpm demo                 all five scenarios
 *   pnpm demo graphql         one scenario by id
 *   pnpm demo --verbose       include every trace line and the candidate set
 *   pnpm demo --keep          keep prior decisions instead of re-deciding
 *
 * Re-deciding is the default because a demo that prints a cached verdict shows none of
 * the reasoning — the stage-by-stage narration is the entire point of watching it run.
 * `--keep` restores the idempotent behaviour, which is what production actually does.
 */

const ARGS = process.argv.slice(2)
const VERBOSE = ARGS.includes('--verbose') || ARGS.includes('-v')
const KEEP = ARGS.includes('--keep')
const ONLY = ARGS.filter((a) => !a.startsWith('-'))

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

/** Refusals are the product, so they are not coloured as failures. */
const OUTCOME_COLOUR: Record<string, (s: string) => string> = {
  ACCEPT: C.green,
  REJECT: C.red,
  MERGE: C.magenta,
  DEFER: C.yellow,
  ESCALATE: C.cyan,
}

const out = (s = '') => process.stdout.write(`${s}\n`)
const rule = (ch = '─') => out(C.dim(ch.repeat(78)))

function wrap(text: string, width = 74, indent = '    '): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line)
      line = w
    } else {
      line = line ? `${line} ${w}` : w
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => `${indent}${l}`).join('\n')
}

async function runScenario(db: Db, s: Scenario, n: number, total: number): Promise<boolean> {
  out()
  rule('━')
  out(`${C.bold(`[${n}/${total}] ${s.beat}`)}`)
  rule('━')

  // ── ingest ───────────────────────────────────────────────────────────────────
  const event = normalize(s.event, {
    internalActors: ['alice', 'bob', 'carol', 'ascendant'],
    knownExternalActors: ['dave-contractor'],
  })
  const { row, inserted } = await insertEvent(db, event)
  /**
   * Rebuilt from the stored row rather than reusing the in-memory value, and through
   * `toNormalized` rather than a cast: `EventRow` is flat (`actorHandle`) while
   * `NormalizedEvent` is nested (`actor.handle`), so a cast typechecks and then throws
   * inside the policy rules. Deciding against the row the dashboard will read also
   * means the demo cannot diverge from what the UI shows.
   */
  const stored = toNormalized(row)

  out()
  out(`  ${C.bold('EVENT')}  ${stored.sourceRef}   ${C.dim(`filed by @${event.actor.handle}, trust=${stored.trust}`)}`)
  out(`  ${C.dim('title')}  ${stored.title}`)
  if (!inserted) out(`  ${C.dim('note')}   already ingested — idempotent on (org, source, sourceRef)`)
  if (event.extracted.symbols.length) {
    out(`  ${C.dim('symbols')} ${event.extracted.symbols.slice(0, 5).join(', ')}${C.dim('  (regex, not a model)')}`)
  }

  // An event already decided is not re-decided: the decision row is immutable, and a
  // second run would double-spend the budget and could post a duplicate comment.
  const prior = await decisionForEvent(db, ORG, stored.id)
  if (prior) {
    out()
    out(`  ${C.dim('already decided —')} ${OUTCOME_COLOUR[prior.outcome]?.(prior.outcome) ?? prior.outcome} ${C.dim(`at ${prior.confidence.toFixed(2)}. Re-run with a fresh seed to decide again.`)}`)
    return prior.outcome === s.expect
  }

  const run = await startRun(db, { orgId: ORG, fn: 'triage', meta: { eventId: stored.id } })
  const ctx = await openRunContext(db, {
    onTrace: VERBOSE ? (t) => out(`    ${C.dim(`· ${t.agent}/${t.phase}`)} ${t.summary}`) : undefined,
  })

  // ── stage 1: the deterministic rules, before any model ────────────────────────
  const policyCtx = await loadPolicyContext(db, stored, ctx.policy.botHandles)
  const verdict = decide(stored, policyCtx)

  out()
  out(`  ${C.bold('STAGE 1')} ${C.dim('deterministic policy rules (free, instant, no model)')}`)
  if (verdict.hits.length === 0) {
    out(`    ${C.dim('no rules fired')}`)
  } else {
    for (const h of verdict.hits) {
      const tag = h.decisive ? C.yellow('DECISIVE') : C.dim('advisory')
      out(`    ${tag} ${C.bold(h.rule)} → ${h.outcome}   ${C.dim(h.note.slice(0, 80))}`)
    }
  }
  if (verdict.decided) {
    out(`    ${C.green('short-circuit')} ${C.dim('— a decisive rule means the LLM is never called (0 tokens)')}`)
  }

  // ── stage 2: retrieval, then the model ───────────────────────────────────────
  let candidates: readonly Candidate[] = []
  if (!verdict.decided) {
    const embedder = makeEmbedder()
    const vec = await embedder.embed(`${stored.title}\n\n${stored.body}`)
    const r = await retrieveCandidates(db, { orgId: ORG, event: stored, vec, dim: 768 })
    candidates = r.candidates

    out()
    out(`  ${C.bold('STAGE 2')} ${C.dim('retrieval before judgement — four sources, unioned')}`)
    const bs = Object.entries(r.bySource)
      .map(([k, v]) => `${k}:${v}`)
      .join('  ')
    out(`    ${bs}   ${C.dim(`→ ${r.candidates.length} candidates, ~${r.tokens} tokens`)}`)
    if (r.degraded.length) out(`    ${C.yellow('degraded')} ${r.degraded.join(', ')}`)
    if (VERBOSE) {
      for (const c of r.candidates.slice(0, 8)) {
        out(`      ${C.dim(`[${c.source}]`)} ${c.ref.padEnd(30)} ${C.dim(`${c.score.toFixed(3)}  ${c.title.slice(0, 40)}`)}`)
      }
    }
  }

  // ── the gate ─────────────────────────────────────────────────────────────────
  out()
  out(`  ${C.bold('THE GATE')} ${C.dim(ctx.mode.kind === 'live' ? ctx.mode.label : 'fixture reasoning; all validation runs for real')}`)

  let result
  try {
    result = await triage(ctx.agent, {
      event: stored,
      candidates,
      policy: verdict,
      bands: ctx.policy.bands,
    })
  } catch (err) {
    // §10.1: every rung exhausted is an ESCALATE, never a crash that loses the event.
    const noCapacity = err instanceof NoCapacityError
    out()
    out(`  ${C.cyan('ESCALATE')} ${C.dim(noCapacity ? 'no_capacity — every model tier exhausted' : String(err))}`)
    await finishRun(db, ORG, run.id, 'failed', { error: String(err) })
    return s.expect === 'ESCALATE'
  }

  const colour = OUTCOME_COLOUR[result.outcome] ?? ((x: string) => x)
  out()
  out(
    `  ${C.bold('DECISION')}  ${colour(C.bold(result.outcome))}  at confidence ${C.bold(result.confidence.toFixed(2))}  ` +
      `${result.autonomous ? C.green('(autonomous)') : C.yellow('(human in the loop)')}`,
  )

  // The three weighted components, stored per-decision so calibration is auditable.
  const c = result.components
  out(
    `    ${C.dim('confidence =')} 0.5×${c.modelSelfReport.toFixed(2)} ${C.dim('self')} ` +
      `+ 0.3×${c.evidenceStrength.toFixed(2)} ${C.dim('evidence')} ` +
      `+ 0.2×${c.policyAgreement.toFixed(2)} ${C.dim('policy')}`,
  )
  if (result.bandApplied.length) {
    out(`    ${C.yellow('bands applied')} ${result.bandApplied.join(', ')}`)
  }
  if (result.decidedByPolicy) {
    out(`    ${C.green('decided by policy')} ${C.dim('— no model call, 0 tokens')}`)
  }

  out()
  out(`  ${C.dim('REASONING')}`)
  out(C.dim(wrap(result.reasoning)))

  out()
  out(`  ${C.dim('CITATIONS')} ${C.dim('(every ref verified against what retrieval actually returned)')}`)
  for (const cit of result.citations) {
    out(`    ${C.blue(cit.ref)}  ${C.dim(`[${cit.kind}]`)}`)
    out(C.dim(wrap(`"${cit.quote}"`, 70, '      ')))
  }
  if (result.mergeTargetId) out(`    ${C.dim('merge target')} ${result.mergeTargetId}`)
  if (result.missingInfo?.length) {
    out()
    out(`  ${C.dim('QUESTIONS POSTED BACK')}`)
    for (const q of result.missingInfo) out(`    ${C.dim('·')} ${q}`)
  }

  // ── persist ──────────────────────────────────────────────────────────────────
  const decision = await insertDecision(db, {
    orgId: ORG,
    eventId: stored.id,
    outcome: result.outcome,
    confidence: result.confidence,
    reasoning: result.reasoning,
    citations: result.citations as never,
    mergeTargetId: result.mergeTargetId,
    missingInfo: result.missingInfo,
    policyHits: result.policyHits,
    modelSelfReport: result.components.modelSelfReport,
    evidenceStrength: result.components.evidenceStrength,
    policyAgreement: result.components.policyAgreement,
    autonomous: result.autonomous,
    needsReview: result.needsReview,
    modelUsed: result.cost.model,
    tokens: result.cost.tokens,
    latencyMs: result.cost.latencyMs,
  })

  for (const t of ctx.traces.splice(0, ctx.traces.length)) {
    await trace(db, {
      orgId: ORG,
      runId: run.id,
      agent: t.agent,
      phase: t.phase,
      round: t.round,
      summary: t.summary,
      detail: t.detail,
      model: t.model,
      tokens: t.tokens ?? 0,
      latencyMs: t.latencyMs ?? 0,
    })
  }

  out()
  out(
    `  ${C.dim('persisted')} decision ${C.dim(decision.id.slice(0, 8))}  ` +
      `${C.dim(`model=${result.cost.model} tokens=${result.cost.tokens} ${result.cost.latencyMs}ms`)}`,
  )

  // ── ACCEPT is the only door into the pipeline ─────────────────────────────────
  if (result.outcome === 'ACCEPT') {
    const ticket = await openTicketForAccept(db, {
      orgId: ORG,
      decision,
      title: stored.title,
      statement: result.reasoning,
    })
    out(`  ${C.green('ticket opened')} ${ticket.id.slice(0, 8)} ${C.dim('— the gate is the only path to code')}`)
    out(`  ${C.dim('→ work/accepted would now start plan-and-code; run `pnpm demo:build` for that stage')}`)
  } else {
    out(`  ${C.dim('no ticket — this is one of the four refusals, which is the point')}`)
  }

  await finishRun(db, ORG, run.id, 'succeeded', {
    tokensUsed: result.cost.tokens,
    llmCalls: result.decidedByPolicy ? 0 : 1,
  })

  const ok = result.outcome === s.expect
  out()
  out(
    ok
      ? `  ${C.green('✓')} ${C.dim(`as expected: ${s.expect} — ${s.why}`)}`
      : `  ${C.red('✗')} expected ${s.expect}, got ${result.outcome} ${C.dim(`(${s.why})`)}`,
  )
  return ok
}

async function main() {
  const { db, handle, migrated } = await openLocalDb()
  if (migrated) {
    // A fresh database has no corpus, so the gate would have nothing to compare
    // against and every refusal would collapse to ESCALATE for lack of evidence.
    out()
    out(C.yellow('  No seeded corpus found. Run `pnpm seed:demo` first.'))
    out(C.dim('  The gate reasons by comparison; with an empty corpus it can only escalate.'))
    out()
    process.exit(1)
  }
  await seedPolicy(db)

  const ctx = await openRunContext(db)
  const chosen = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS

  out()
  out(C.bold('  Ascendant — Triage Gate'))
  out(C.dim('  Decides what to build. Then builds it.'))
  out()
  out(`  ${C.dim('model')}     ${ctx.mode.label}`)
  out(`  ${C.dim('database')}  local PGlite (real Postgres + pgvector)`)
  out(`  ${C.dim('bands')}     autonomous ≥ ${ctx.policy.bands.autonomous}, flagged ≥ ${ctx.policy.bands.flagged}, else ESCALATE`)
  if (!chosen.length) {
    out()
    out(C.red(`  No scenario matched: ${ONLY.join(', ')}`))
    out(C.dim(`  Available: ${SCENARIOS.map((s) => s.id).join(', ')}`))
    process.exit(1)
  }

  // Clear only the chosen scenarios' own events; the corpus they are compared against
  // stays. Done after `chosen` resolves so `pnpm demo graphql` re-decides that one
  // scenario and leaves the other four's decisions intact.
  if (!KEEP) {
    const cleared = await resetScenarios(
      handle,
      ORG,
      chosen.map((s) => s.event.sourceRef),
    )
    if (cleared > 0) {
      out(`  ${C.dim('reset')}     ${cleared} prior decision${cleared === 1 ? '' : 's'} cleared — the gate decides again (--keep to preserve)`)
    }
  }

  const results: boolean[] = []
  for (const [i, s] of chosen.entries()) {
    results.push(await runScenario(db, s, i + 1, chosen.length))
  }

  out()
  rule('━')
  const passed = results.filter(Boolean).length
  out(
    passed === results.length
      ? `  ${C.green(`All ${results.length} scenarios reached their expected outcome.`)}`
      : `  ${C.red(`${results.length - passed} of ${results.length} scenarios did not match.`)}`,
  )
  out()
  out(`  ${C.dim('Four of the five outcomes are refusals — that is the product.')}`)
  out(`  ${C.dim('Dashboard: pnpm dev → http://localhost:3000')}`)
  out()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\ndemo failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
