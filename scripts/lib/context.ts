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

export interface ModelMode {
  kind: 'live' | 'fixture'
  /** What to show the operator, e.g. "Groq (llama-3.3-70b-versatile ladder)". */
  label: string
}

export function modelMode(): ModelMode {
  const hasGroq = Boolean(process.env.GROQ_API_KEY)
  const hasGemini = Boolean(process.env.GEMINI_API_KEY)
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY)

  if (hasGroq || hasGemini || hasOpenRouter) {
    const which = [hasGroq && 'Groq', hasGemini && 'Gemini', hasOpenRouter && 'OpenRouter']
      .filter(Boolean)
      .join(' → ')
    return { kind: 'live', label: `live inference via ${which}` }
  }
  return {
    kind: 'fixture',
    label: 'recorded fixtures (no LLM key set — set GROQ_API_KEY for live inference)',
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
