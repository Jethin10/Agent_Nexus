import { db, readPolicy, spendToday, trace as writeTrace, type Db, type Policy } from '@ascendant/db'
import { Budget, RouterState, complete, type ProviderEnv } from '@ascendant/router'
import type { AgentContext, AgentTrace } from '@ascendant/agents'

/**
 * The workflow layer is the only place that does I/O (R1). This file is that
 * boundary: it reads env, opens the DB, binds the router, and hands agents a
 * context object they cannot see past.
 *
 * Agents receive `complete` as a value rather than importing it, which is what lets
 * every agent test supply a canned model response instead of mocking a module.
 */
export function providerEnv(): ProviderEnv {
  return {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  }
}

/**
 * Router state is per-process, deliberately. It is a hint for choosing a rung, not
 * an accounting record: a cold serverless function starts optimistic and corrects on
 * the first 429, while the authoritative daily spend lives in `agent_events`.
 */
const state = new RouterState()

export interface RunContext {
  orgId: string
  db: Db
  policy: Policy
  budget: Budget
  agent: AgentContext
  /** Everything the agents traced, for the caller to persist in one batch. */
  traces: AgentTrace[]
}

export interface OpenRunOptions {
  orgId: string
  ticketId?: string | undefined
  runId?: string | undefined
  signal?: AbortSignal
}

/**
 * Builds everything an agent needs for one pipeline step.
 *
 * The budget is seeded with the org's real spend so far today, read from
 * `agent_events`. That is what makes the §10.4 daily ceiling actually bind: a
 * runaway loop at 2am must not be able to leave the demo without quota at 10am, and
 * a per-process counter would forget about it on the next cold start.
 */
export async function openRun(opts: OpenRunOptions): Promise<RunContext> {
  const database = db()
  const [policy, spend] = await Promise.all([
    readPolicy(database, opts.orgId),
    spendToday(database, opts.orgId),
  ])

  const budget = new Budget(
    {
      ticketTokens: policy.ticketTokens,
      ticketLlmCalls: policy.ticketLlmCalls,
      orgDailyTokens: policy.orgDailyTokens,
    },
    spend.tokens,
  )

  const traces: AgentTrace[] = []
  const env = providerEnv()

  const agent: AgentContext = {
    orgId: opts.orgId,
    complete: (o) =>
      complete(
        {
          ...o,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        {
          env,
          state,
          budget,
          /**
           * Router attempts are traced individually so the Run Detail view can show
           * a cascade hop or a schema repair as a real event rather than as an
           * unexplained latency spike.
           */
          onAttempt: (a) => {
            if (a.outcome === 'ok') return
            traces.push({
              agent: 'router',
              phase: a.outcome,
              summary: `${a.model}: ${a.outcome}${a.detail ? ` — ${a.detail.slice(0, 200)}` : ''}`,
              detail: { model: a.model, outcome: a.outcome },
              model: a.model,
            })
          },
        },
      ),
    trace: (t) => {
      traces.push(t)
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  }

  return { orgId: opts.orgId, db: database, policy, budget, agent, traces }
}

/**
 * Persists the collected traces. Called once per step rather than per trace: each
 * write is an HTTP round trip on the neon-http driver (D9), and a debate round can
 * produce a dozen lines.
 */
export async function flushTraces(
  ctx: RunContext,
  target: { ticketId?: string | undefined; runId?: string | undefined },
): Promise<void> {
  const pending = ctx.traces.splice(0, ctx.traces.length)
  for (const t of pending) {
    await writeTrace(ctx.db, {
      orgId: ctx.orgId,
      ticketId: target.ticketId,
      runId: target.runId,
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
}
