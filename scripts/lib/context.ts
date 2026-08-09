import { setDb, writeConfig, type Db } from '@ascendant/db'
import { applyMigrations, makeLocalDb, type LocalDbHandle } from '@ascendant/db/local'
import { readPolicy, spendToday } from '@ascendant/db'
import { Budget, RouterState, complete } from '@ascendant/router'
import type { AgentContext, AgentTrace } from '@ascendant/agents'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { offlineComplete } from './offline-model.ts'

/**
 * Shared setup for the scripts: opens the local database, applies migrations, and
 * builds the `AgentContext` the agents run against.
 *
 * This mirrors `packages/workflows/src/runtime.ts` deliberately rather than importing
 * it, because that module hard-binds `db()` to a Neon URL and reads env for provider
 * keys. The seam it exposes — agents receive `complete` as a value (R1) — is what
 * makes an offline run possible without touching any of the eight agents.
 */

export const ORG_ID = process.env.ASCENDANT_ORG_ID ?? 'org_demo'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `<repo>/.ascendant/pgdata` — gitignored, so a seeded corpus survives between runs. */
export const DATA_DIR = join(HERE, '..', '..', '.ascendant', 'pgdata')

export interface OpenDbOptions {
  /** Discard any existing database first. `pnpm seed:demo` does this. */
  fresh?: boolean
  /** In-memory instead of on disk. Used by tests. */
  memory?: boolean
}

export interface OpenedDb {
  handle: LocalDbHandle
  db: Db
  /** True when the schema was created by this call rather than already present. */
  migrated: boolean
}

/**
 * Opens the local database and installs it as the process-wide `db()`, so every
 * query helper — and the dashboard's server components — reach it without knowing it
 * is PGlite rather than Neon.
 */
export async function openLocalDb(opts: OpenDbOptions = {}): Promise<OpenedDb> {
  if (!opts.memory) mkdirSync(DATA_DIR, { recursive: true })

  if (opts.fresh && !opts.memory) {
    const { rmSync } = await import('node:fs')
    rmSync(DATA_DIR, { recursive: true, force: true })
    mkdirSync(DATA_DIR, { recursive: true })
  }

  const handle = await makeLocalDb(opts.memory ? undefined : DATA_DIR)

  // `events` is the first table the migration creates, so its absence means a fresh
  // database. Checking rather than always migrating keeps `pnpm demo` re-runnable.
  const existing = await handle.client.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables
     where table_schema = 'public' and table_name = 'events'`,
  )
  const alreadyMigrated = Number(existing.rows[0]?.n ?? 0) > 0
  if (!alreadyMigrated) await applyMigrations(handle.db)

  setDb(handle.db)
  return { handle, db: handle.db, migrated: !alreadyMigrated }
}

/**
 * Deletes the decisions produced by a previous `pnpm demo`, so the gate decides the
 * scenarios again from the same corpus.
 *
 * This exists here rather than in `db/queries/events.ts` on purpose: that module states
 * that nothing in it ever deletes a row, because replay depends on input rows surviving.
 * The scenario events are demo scaffolding rather than ingested history, so resetting
 * them is a property of the demo runner, not of the query layer.
 *
 * Deleting the *event* rather than the decision is what makes the run identical to a
 * first run: `decisions` cascades from `events`, and so do `tickets`, and `outcomes`
 * cascades from `decisions`. Deleting only the decision would leave an ingested event
 * whose `inserted: false` path prints "already ingested" and skips the insert branch.
 *
 * The corpus the gate reasons *against* — the ADRs, the prior issues, the fix PRs, the
 * embeddings — is untouched. Wiping that would starve retrieval and collapse every
 * refusal to ESCALATE for lack of evidence.
 */
export async function resetScenarios(
  handle: LocalDbHandle,
  orgId: string,
  sourceRefs: readonly string[],
): Promise<number> {
  if (sourceRefs.length === 0) return 0
  const list = sourceRefs.map((r) => `'${r.replace(/'/g, "''")}'`).join(', ')
  const res = await handle.client.query<{ id: string }>(
    `delete from events where org_id = $1 and source_ref in (${list}) returning id`,
    [orgId],
  )
  return res.rows.length
}

export interface ModelMode {
  kind: 'live' | 'fixture'
  /** What to show the operator, e.g. "Groq (llama-3.3-70b-versatile ladder)". */
  label: string
}

/**
 * Which `complete()` the agents get.
 *
 * Live inference is opt-in via `ASCENDANT_LIVE=1` rather than implied by the presence
 * of a key. The two are not the same question: the ladder's triage rungs are Groq
 * (capability 0.95) and the OpenRouter rung is a 0.8 fallback sized for overflow, so a
 * shell holding only `OPENROUTER_API_KEY` used to be treated as fully live and ran the
 * whole demo on the weakest rung. That reliably lost two of the five beats — a valid
 * key produced a worse result than no key, which is the wrong way round for a
 * credential to fail.
 *
 * Keeping fixtures as the default also makes the demo hermetic: no network, no daily
 * quota, no 15-second latency per scenario, and identical output every run. Everything
 * around the reasoning — the policy rules, all four retrieval sources, citation
 * validation, the confidence recomputation, banding, the ESCALATE overrides — is the
 * real code path either way, and every fixture is labelled `fixture:*` wherever it
 * surfaces so it can never be mistaken for inference.
 */
export function modelMode(): ModelMode {
  const hasGroq = Boolean(process.env.GROQ_API_KEY)
  const hasGemini = Boolean(process.env.GEMINI_API_KEY)
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY)
  const hasKey = hasGroq || hasGemini || hasOpenRouter

  if (process.env.ASCENDANT_LIVE === '1' && hasKey) {
    const which = [hasGroq && 'Groq', hasGemini && 'Gemini', hasOpenRouter && 'OpenRouter']
      .filter(Boolean)
      .join(' → ')
    return { kind: 'live', label: `live inference via ${which}` }
  }
  if (process.env.ASCENDANT_LIVE === '1') {
    return {
      kind: 'fixture',
      label: 'recorded fixtures (ASCENDANT_LIVE=1 but no provider key is set)',
    }
  }
  return {
    kind: 'fixture',
    label: hasKey
      ? 'recorded fixtures (a key is set — ASCENDANT_LIVE=1 to use it)'
      : 'recorded fixtures (no LLM key set — set GROQ_API_KEY and ASCENDANT_LIVE=1)',
  }
}

export interface RunContext {
  orgId: string
  db: Db
  agent: AgentContext
  traces: AgentTrace[]
  mode: ModelMode
  policy: Awaited<ReturnType<typeof readPolicy>>
  budget: Budget
}

const state = new RouterState()

/**
 * Builds the agent context.
 *
 * The only difference between the live and offline paths is which function lands in
 * `agent.complete`. Everything downstream of that — retrieval, citation validation,
 * the confidence recomputation, banding, the ESCALATE overrides — is identical, which
 * is what makes the offline run a real exercise of the gate rather than a puppet show.
 */
export async function openRunContext(
  db: Db,
  opts: { onTrace?: (t: AgentTrace) => void; onModelCall?: (task: string, model: string) => void } = {},
): Promise<RunContext> {
  const mode = modelMode()
  const [policy, spend] = await Promise.all([readPolicy(db, ORG_ID), spendToday(db, ORG_ID)])

  const budget = new Budget(
    {
      ticketTokens: policy.ticketTokens,
      ticketLlmCalls: policy.ticketLlmCalls,
      orgDailyTokens: policy.orgDailyTokens,
    },
    spend.tokens,
  )

  const traces: AgentTrace[] = []
  const push = (t: AgentTrace) => {
    traces.push(t)
    opts.onTrace?.(t)
  }

  const live: AgentContext['complete'] = (o) =>
    complete(o, {
      env: {
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
      },
      state,
      budget,
      onAttempt: (a) => {
        opts.onModelCall?.('router', a.model)
        if (a.outcome === 'ok') return
        push({
          agent: 'router',
          phase: a.outcome,
          summary: `${a.model}: ${a.outcome}${a.detail ? ` — ${a.detail.slice(0, 200)}` : ''}`,
          detail: { model: a.model, outcome: a.outcome },
          model: a.model,
        })
      },
    })

  const fixture = offlineComplete({
    ...(opts.onModelCall ? { onCall: opts.onModelCall } : {}),
  })

  const agent: AgentContext = {
    orgId: ORG_ID,
    complete: mode.kind === 'live' ? live : fixture,
    trace: push,
  }

  return { orgId: ORG_ID, db, agent, traces, mode, policy, budget }
}

/**
 * Seeds the policy rows the gate depends on.
 *
 * `actors.internal` is not cosmetic: `deriveTrust` returns `'anonymous'` for any
 * handle it does not recognise, and an anonymous event can never act autonomously
 * (§15.3 layer 3). Without this the demo's autonomous refusals would all silently
 * become ESCALATEs, which looks like a broken gate rather than a missing config row.
 */
export async function seedPolicy(db: Db): Promise<void> {
  await writeConfig(db, ORG_ID, 'actors.internal', ['alice', 'bob', 'carol', 'ascendant'], {
    note: 'Seeded by scripts — internal handles get the full autonomy ceiling.',
    updatedBy: 'seed',
  })
  await writeConfig(db, ORG_ID, 'actors.knownExternal', ['dave-contractor'], {
    note: 'Seeded by scripts — known external contributors.',
    updatedBy: 'seed',
  })
  await writeConfig(db, ORG_ID, 'actors.bots', ['dependabot', 'renovate', 'github-actions'], {
    note: 'Seeded by scripts — the bot_author rule REJECTs these before any model call.',
    updatedBy: 'seed',
  })
}
