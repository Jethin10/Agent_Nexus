import type { z } from 'zod'
import type { Budget, RouterAttempt, RouterState, TaskClass } from '@ascendant/router'
import type { ProviderEnv } from '@ascendant/router'

/**
 * R1, the invariant the whole design rests on: **every agent is a pure function
 * `(ctx) => output`.** No agent touches Linear, GitHub, or the database directly;
 * only the workflow layer does I/O.
 *
 * That is why all seven agents are unit-testable with no network, and why the
 * pipeline is replayable from stored rows: an agent's entire input is this context
 * object, so replaying a run means re-supplying the same object.
 *
 * The one capability an agent does get is `complete` — the router's contract, passed
 * in rather than imported, so a test supplies a canned model response instead of
 * mocking a module.
 */
export interface AgentContext {
  orgId: string
  /** The router's complete(), pre-bound with env, state and budget by the workflow. */
  complete: CompleteFn
  /** Timeline hook. The workflow writes these to `agent_events`. */
  trace?: (t: AgentTrace) => void | Promise<void>
  signal?: AbortSignal
}

export type CompleteFn = <T>(opts: {
  task: TaskClass
  /** Output-typed, matching the router's contract — see CompleteOptions.schema. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  system: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  maxTokens?: number
  temperature?: number
}) => Promise<{
  value: T
  model: string
  tokens: number
  latencyMs: number
  attempts: RouterAttempt[]
}>

export interface AgentTrace {
  agent: string
  phase: string
  round?: number
  summary: string
  detail?: Record<string, unknown>
  model?: string
  tokens?: number
  latencyMs?: number
}

/** Everything an agent returns carries its own cost, so accounting is never inferred. */
export interface AgentCost {
  model: string
  tokens: number
  latencyMs: number
}

export interface RouterBinding {
  env: ProviderEnv
  state?: RouterState
  budget?: Budget
  fetcher?: typeof fetch
}
