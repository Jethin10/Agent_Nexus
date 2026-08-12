import { eq, sql } from 'drizzle-orm'
import { normalize, type NormalizedEvent } from '@ascendant/core'
import {
  decisions as decisionsTable,
  embeddings,
  decisionForEvent,
  executeRows,
  insertDecision,
  insertEvent,
  openTicketForAccept,
  recordOutcome,
  recordOverturn,
  tickets as ticketsTable,
  type Db,
} from '@ascendant/db'
import { CORPUS, ORG, daysAgo } from './lib/fixtures.ts'
import { makeEmbedder } from './lib/embed.ts'
import { openLocalDb, seedPolicy } from './lib/context.ts'

/**
 * Builds the demo corpus: the history the gate reasons *against*.
 *
 * This script deliberately does not decide anything. It seeds events, embeddings, a
 * plausible decision history and the config rows — then `pnpm demo` puts the five live
 * scenarios through the real gate. Keeping the two apart is what lets the demo claim
 * the outcomes are produced rather than replayed, so the seeded decisions here are all
 * *historical* ones that predate the scenarios.
 *
 *   pnpm seed:demo            → fresh database, seeded corpus
 *   pnpm seed:demo --keep     → add to whatever is already there
 */

const FRESH = !process.argv.includes('--keep')

const INTERNAL = ['alice', 'bob', 'carol', 'ascendant']
const KNOWN_EXTERNAL = ['dave-contractor']
const BOTS = ['dependabot', 'renovate', 'github-actions']

function log(step: string, detail = '') {
  process.stdout.write(`  ${step.padEnd(34)}${detail}\n`)
}

async function main() {
  process.stdout.write('\nSeeding the demo corpus\n\n')

  const { db, migrated } = await openLocalDb({ fresh: FRESH })
  log('database', migrated ? 'created, schema applied' : 'reusing existing')

  await seedPolicy(db)
  log('config', 'actors.internal, knownExternal, bots')

  // ---- events -------------------------------------------------------------------
  // normalize() derives trust from the actor handle against the internal lists, so the
  // same handles seeded into config must be passed here or every event lands
  // 'anonymous' and autonomy becomes impossible for reasons invisible in the UI.
  const normalized: NormalizedEvent[] = []
  let inserted = 0
  for (const raw of CORPUS) {
    const n = normalize(raw, {
      internalActors: INTERNAL,
      knownExternalActors: KNOWN_EXTERNAL,
    })
    const res = await insertEvent(db, n)
    normalized.push(res.row as unknown as NormalizedEvent)
    if (res.inserted) inserted += 1
  }
  log('events', `${inserted} inserted, ${CORPUS.length - inserted} already present`)

  // ---- embeddings ---------------------------------------------------------------
  // No insert helper exists for this table (it is written by the ingest workflow in
  // production), so this is a raw insert. The unique index on
  // (org_id, entity_kind, entity_id, chunk) makes it idempotent.
  const embedder = makeEmbedder()
  log('embedder', embedder.label)

  let embedded = 0
  for (const [i, n] of normalized.entries()) {
    const text = `${n.title}\n\n${n.body}`.slice(0, 8_000)
    const vec = await embedder.embed(text)
    await db
      .insert(embeddings)
      .values({
        orgId: ORG,
        entityKind: 'event',
        entityId: n.id,
        content: text,
        chunk: 0,
        model: embedder.model,
        vec768: vec,
      })
      .onConflictDoNothing({
        target: [embeddings.orgId, embeddings.entityKind, embeddings.entityId, embeddings.chunk],
      })
    embedded += 1
    if (embedder.kind === 'gemini' && i % 10 === 9) log('  embedding', `${i + 1}/${normalized.length}`)
  }
  log('embeddings', `${embedded} vectors (${embedder.kind === 'hash' ? 'hashed' : 'semantic'})`)

  // ---- historical decisions -----------------------------------------------------
  // The Metrics page needs decisions inside the 30-day velocity window, at least one
  // autonomous decision for the confusion matrix to render, outcomes with durationMs
  // for cycle time, and overturns for the off-diagonal cells.
  const byRef = new Map(normalized.map((n) => [n.sourceRef, n]))
  const need = (ref: string) => {
    const n = byRef.get(ref)
    if (!n) throw new Error(`seed: expected ${ref} in the corpus`)
    return n
  }

  interface Hist {
    ref: string
    outcome: 'ACCEPT' | 'REJECT' | 'MERGE' | 'DEFER' | 'ESCALATE'
    confidence: number
    autonomous: boolean
    reasoning: string
    cite: { ref: string; quote: string; why: string }
    mergeTargetId?: string
    missingInfo?: string[]
    /** Ticket + delivery history, for ACCEPTs. */
    delivered?: { prNumber: number; status: 'done'; tokens: number; calls: number; durationMs: number }
    /** A human later disagreed — one of these produces the off-diagonal cell. */
    overturnTo?: 'ACCEPT'
  }

  const history: Hist[] = [
    {
      ref: 'acme/api#380',
      outcome: 'ACCEPT',
      confidence: 0.86,
      autonomous: true,
      reasoning:
        'Specific, reproducible middleware bug with a named file and a clear expected behaviour. Preflight requests should not consume a caller budget; the fix is local to the rate limiter.',
      cite: {
        ref: 'acme/api#380',
        quote: 'counts CORS preflight requests against the caller budget',
        why: 'The report names the file and the exact incorrect behaviour.',
      },
      delivered: { prNumber: 71, status: 'done', tokens: 18_400, calls: 7, durationMs: 512_000 },
    },
    {
      ref: 'acme/api#385',
      outcome: 'REJECT',
      confidence: 0.83,
      autonomous: true,
      reasoning:
        'This is a support question about existing functionality, not a defect or a change request. The triage sync agreed questions belong in discussions rather than the issue tracker.',
      cite: {
        ref: 'granola:2026-07-02-triage-sync',
        quote: 'support questions should be redirected to discussions rather than opened as issues',
        why: 'A recorded team decision covering exactly this class of issue.',
      },
    },
    {
      ref: 'acme/api#391',
      outcome: 'ACCEPT',
      confidence: 0.84,
      autonomous: true,
      reasoning:
        'Concrete correctness bug in pagination with a named file and a described failure mode. A deleted row between pages returning a 500 is unambiguous incorrect behaviour.',
      cite: {
        ref: 'acme/api#391',
        quote: 'the next request returns a 500 instead of skipping it',
        why: 'The reporter states the actual and expected behaviour.',
      },
      delivered: { prNumber: 74, status: 'done', tokens: 21_900, calls: 9, durationMs: 640_000 },
    },
    {
      ref: 'acme/api#394',
      outcome: 'REJECT',
      confidence: 0.95,
      autonomous: true,
      reasoning:
        'Automated dependency bump filed by a bot. The bot_author policy rule refuses these before any model call, so no inference was needed to reach this outcome.',
      cite: {
        ref: 'policy:bot_author',
        quote: 'dependabot is a configured bot handle',
        why: 'Deterministic rule, matched before the model was consulted.',
      },
    },
    {
      ref: 'acme/api#399',
      outcome: 'ACCEPT',
      confidence: 0.81,
      autonomous: true,
      reasoning:
        'Serialisation defect with a clear specification to conform to. Emitting timestamps without an offset is incorrect for any client outside the server timezone.',
      cite: {
        ref: 'acme/api#399',
        quote: 'serialise createdAt without an offset, so clients in other zones misread it',
        why: 'Names the field, the file and the correct format.',
      },
      delivered: { prNumber: 79, status: 'done', tokens: 16_100, calls: 6, durationMs: 445_000 },
    },
    {
      ref: 'acme/api#403',
      outcome: 'DEFER',
      confidence: 0.78,
      autonomous: false,
      reasoning:
        'The report contains no reproduction, no error output, no affected endpoint and no version. There is nothing here to act on, and guessing at the intent would waste a review cycle.',
      cite: {
        ref: 'acme/api#403',
        quote: 'doesnt work',
        why: 'The entire body of the report, quoted in full.',
      },
      missingInfo: [
        'Which endpoint or operation fails?',
        'What error or response do you see?',
        'Which version are you running?',
      ],
    },
    {
      ref: 'acme/api#407',
      outcome: 'ACCEPT',
      confidence: 0.87,
      autonomous: true,
      reasoning:
        'A health check that reports healthy while its dependency is unreachable actively misleads a load balancer. The report names the file and the correct behaviour.',
      cite: {
        ref: 'acme/api#407',
        quote: 'returns 200 based on process liveness only',
        why: 'Identifies the precise inadequacy of the current check.',
      },
      delivered: { prNumber: 83, status: 'done', tokens: 14_700, calls: 6, durationMs: 388_000 },
    },
    {
      ref: 'acme/api#415',
      outcome: 'MERGE',
      confidence: 0.89,
      autonomous: true,
      reasoning:
        'Identical stack frame, identical error string and the same originating version as the earlier report. This is the same defect described a second time, not a new one.',
      cite: {
        ref: 'acme/api#412',
        quote: "TypeError: cannot read 'id' of undefined",
        why: 'The same error at the same frame in the earlier open issue.',
      },
      mergeTargetId: 'acme/api#412',
    },
    {
      ref: 'acme/api#421',
      outcome: 'ACCEPT',
      confidence: 0.82,
      autonomous: true,
      reasoning:
        'Information disclosure through validation errors. Internal column naming should not reach a client; the mapping belongs in the validation layer the report names.',
      cite: {
        ref: 'acme/api#421',
        quote: 'echoes the internal Zod path, e.g. user.internal_id',
        why: 'Concrete example of the leaked value.',
      },
    },
    {
      ref: 'acme/api#428',
      outcome: 'ESCALATE',
      confidence: 0.52,
      autonomous: false,
      reasoning:
        'The described behaviour is real, but whether retrying a timed-out POST is acceptable depends on server-side idempotency guarantees this system cannot observe. A wrong answer either double-applies writes or removes resilience.',
      cite: {
        ref: 'acme/api#428',
        quote: 'a POST that timed out server-side can be applied twice',
        why: 'The risk is stated, but the correct policy is a judgement call.',
      },
    },
    {
      ref: 'acme/api#433',
      outcome: 'DEFER',
      confidence: 0.71,
      autonomous: false,
      reasoning:
        'A reasonable feature request, but it needs a delivery contract before it can be built: retry semantics, payload shape and authentication are all unspecified.',
      cite: {
        ref: 'acme/api#433',
        quote: 'receive a webhook when a session is created or revoked',
        why: 'The desired outcome is clear; the contract is not.',
      },
      missingInfo: [
        'What retry and ordering guarantees are expected?',
        'How should the receiver authenticate the callback?',
      ],
    },
    {
      ref: 'acme/api#438',
      outcome: 'ACCEPT',
      confidence: 0.8,
      autonomous: true,
      reasoning:
        'Interleaved log output breaks downstream parsing and is a single-call fix in the named module. Low risk, clearly correct.',
      cite: {
        ref: 'acme/api#438',
        quote: 'concurrent requests interleave and break log parsing',
        why: 'States the mechanism and the consequence.',
      },
      delivered: { prNumber: 93, status: 'done', tokens: 11_200, calls: 5, durationMs: 296_000 },
    },
    {
      ref: 'acme/api#442',
      outcome: 'ACCEPT',
      confidence: 0.91,
      autonomous: true,
      reasoning:
        'Cross-tenant cache leakage. The key omits the tenant, so one tenant can read another tenant response. This is both a correctness and an isolation defect.',
      cite: {
        ref: 'acme/api#442',
        quote: "two tenants requesting the same path can read each other's cached response",
        why: 'The reporter identifies the missing key component directly.',
      },
      delivered: { prNumber: 91, status: 'done', tokens: 24_300, calls: 10, durationMs: 703_000 },
    },
    {
      // The seeded mistake. A human later decided this was worth fixing, which is what
      // populates the REJECT→ACCEPT cell and makes the false-refusal count non-zero.
      // A confusion matrix with an empty off-diagonal reads as untested, not as perfect.
      ref: 'acme/api#447',
      outcome: 'REJECT',
      confidence: 0.81,
      autonomous: true,
      reasoning:
        'Documentation drift rather than a defect in the API itself. The parameter was removed intentionally in v2.2 and the current validation error is correct behaviour.',
      cite: {
        ref: 'acme/api#447',
        quote: 'It was removed in v2.2 and now returns a validation error',
        why: 'The reporter confirms the removal was intentional.',
      },
      overturnTo: 'ACCEPT',
    },
  ]

  let nAuto = 0
  const decisionRows: { ref: string; id: string; outcome: string }[] = []
  let skipped = 0

  for (const h of history) {
    const ev = need(h.ref)

    /**
     * `decisions` is append-only by design (§11.3: a human who disagrees records an
     * overturn, never an edit), so there is no upsert to lean on the way `insertEvent`
     * and `openTicketForAccept` do. Re-running with --keep must therefore check first,
     * or the seeded history doubles and every metric derived from it — the confusion
     * matrix, velocity, the refusal counts — silently doubles with it.
     */
    const already = await decisionForEvent(db, ORG, ev.id)
    if (already) {
      decisionRows.push({ ref: h.ref, id: already.id, outcome: already.outcome })
      skipped += 1
      continue
    }

    const d = await insertDecision(db, {
      orgId: ORG,
      eventId: ev.id,
      outcome: h.outcome,
      confidence: h.confidence,
      reasoning: h.reasoning,
      citations: [{ kind: h.cite.ref.startsWith('doc:') || h.cite.ref.startsWith('granola:') ? 'doc' : h.cite.ref.includes('!') ? 'pr' : 'issue', ...h.cite }],
      policyHits: h.ref === 'acme/api#394' ? ['bot_author'] : [],
      ...(h.mergeTargetId ? { mergeTargetId: h.mergeTargetId } : {}),
      ...(h.missingInfo ? { missingInfo: h.missingInfo } : {}),
      // Historical rows are synthetic, but the displayed confidence decomposition must
      // still reconstruct exactly. Equal components preserve h.confidence under the
      // 0.5/0.3/0.2 weighted sum instead of showing judges inconsistent arithmetic.
      modelSelfReport: h.confidence,
      evidenceStrength: h.confidence,
      policyAgreement: h.confidence,
      autonomous: h.autonomous,
      needsReview: !h.autonomous,
      modelUsed: h.ref === 'acme/api#394' ? 'policy' : 'groq/llama-3.3-70b-versatile',
      tokens: h.ref === 'acme/api#394' ? 0 : 700 + Math.floor(h.confidence * 900),
      latencyMs: h.ref === 'acme/api#394' ? 0 : 900 + Math.floor(h.confidence * 1_400),
    })
    if (h.autonomous) nAuto += 1
    decisionRows.push({ ref: h.ref, id: d.id, outcome: d.outcome })

    // Backdate the decision so the velocity chart shows a spread rather than a spike.
    const age = Math.max(1, Math.round((Date.now() - ev.createdAt.getTime()) / 86_400_000) - 1)
    await db
      .update(decisionsTable)
      .set({ createdAt: daysAgo(Math.min(age, 27)) })
      .where(eq(decisionsTable.id, d.id))

    if (h.delivered) {
      const t = await openTicketForAccept(db, {
        orgId: ORG,
        decision: d,
        title: ev.title,
        statement: `Fix: ${ev.title}`,
        labels: ['seeded'],
      })
      await db
        .update(ticketsTable)
        .set({
          status: h.delivered.status,
          prNumber: h.delivered.prNumber,
          prUrl: `https://github.com/acme/api/pull/${h.delivered.prNumber}`,
          prIsDraft: false,
          branch: `ascendant/${ev.sourceRef.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
          tokensUsed: h.delivered.tokens,
          llmCalls: h.delivered.calls,
          closedAt: daysAgo(Math.min(age, 26)),
          updatedAt: daysAgo(Math.min(age, 26)),
        })
        .where(eq(ticketsTable.id, t.id))

      await recordOutcome(db, {
        orgId: ORG,
        decisionId: d.id,
        ticketId: t.id,
        kind: 'pr_merged',
        correct: true,
        reviewCycles: h.delivered.calls > 8 ? 2 : 1,
        tokensTotal: h.delivered.tokens,
        durationMs: h.delivered.durationMs,
        note: 'Seeded history — PR merged without further changes.',
      })
    } else {
      await recordOutcome(db, {
        orgId: ORG,
        decisionId: d.id,
        kind: h.overturnTo ? 'issue_reopened' : 'human_confirmed',
        correct: !h.overturnTo,
        durationMs: 60_000 + Math.floor(h.confidence * 90_000),
        note: h.overturnTo
          ? 'Seeded history — a maintainer disagreed with this refusal.'
          : 'Seeded history — refusal reviewed and upheld.',
      })
    }

    if (h.overturnTo) {
      await recordOverturn(db, {
        orgId: ORG,
        decisionId: d.id,
        fromOutcome: h.outcome,
        toOutcome: h.overturnTo,
        actor: 'bob',
        reason:
          'Docs drift still costs users real time, and the fix is a one-line README change. Worth doing.',
      })
    }
  }
  log('decisions', `${history.length - skipped} historical, ${nAuto} autonomous${skipped ? `, ${skipped} already present` : ''}`)
  log('tickets', `${history.filter((h) => h.delivered).length} delivered`)
  log('outcomes + overturns', `${history.length} outcomes, 1 overturn (seeded mistake)`)

  // ---- decision embeddings ------------------------------------------------------
  // Source 4, decision memory: "have we answered something like this before". Without
  // these the gate cannot be consistent with its own past refusals.
  for (const dr of decisionRows) {
    const ev = need(dr.ref)
    const text = `${dr.outcome}: ${ev.title}`
    await db
      .insert(embeddings)
      .values({
        orgId: ORG,
        entityKind: 'decision',
        entityId: dr.id,
        content: text,
        chunk: 0,
        model: embedder.model,
        vec768: await embedder.embed(text),
      })
      .onConflictDoNothing({
        target: [embeddings.orgId, embeddings.entityKind, embeddings.entityId, embeddings.chunk],
      })
  }
  log('decision embeddings', `${decisionRows.length} vectors`)

  const counts = await countRows(db)
  process.stdout.write('\n  Seeded:\n')
  for (const r of counts) {
    process.stdout.write(`    ${r.table.padEnd(16)}${r.n}\n`)
  }

  process.stdout.write('\n  Next: pnpm demo    (runs the five live scenarios through the gate)\n')
  process.stdout.write('        pnpm dev     (dashboard at http://localhost:3000)\n\n')
  process.exit(0)
}

/** Row counts for the seed summary, so the output is evidence rather than assertion. */
async function countRows(db: Db): Promise<{ table: string; n: number }[]> {
  return executeRows<{ table: string; n: number }>(
    db,
    sql`
      select 'events' as "table", count(*)::int as n from events
      union all select 'embeddings', count(*)::int from embeddings
      union all select 'decisions', count(*)::int from decisions
      union all select 'tickets', count(*)::int from tickets
      union all select 'outcomes', count(*)::int from outcomes
      union all select 'overturns', count(*)::int from overturns
      union all select 'config', count(*)::int from config
      order by 1`,
  )
}

main().catch((err) => {
  process.stderr.write(`\nseed failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
