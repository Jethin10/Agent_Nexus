import type { z } from 'zod'
import { estimateTokens } from '@ascendant/core'
import { laddersFor, type TaskClass } from './models.js'
import { RouterState, scoreModels } from './state.js'
import { Budget } from './budget.js'
import {
  NoCapacityError,
  ProviderError,
  RateLimitError,
  callProvider,
  hasKey,
  type Fetcher,
  type Message,
  type ProviderEnv,
} from './providers.js'

/**
 * §10 — the router's whole contract. Given a task class and a Zod schema, return
 * validated typed output or throw a typed error. Every agent calls only this, and no
 * agent knows which provider served it.
 */
export interface CompleteOptions<T> {
  task: TaskClass
  /**
   * `z.ZodType<T, ZodTypeDef, unknown>`, not `z.ZodType<T>`. The two-parameter form
   * binds T to the schema's *input* type, which makes every `.default()` field read
   * as `| undefined` at the call site even though `parse` always fills it. Pinning
   * the input to `unknown` binds T to the **output** type instead — which is what
   * the router actually returns, since it validates before it hands anything back.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  system: string
  messages: Message[]
  /** For budget accounting — §10.4. */
  ticketId?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface CompleteResult<T> {
  value: T
  model: string
  tokens: number
  latencyMs: number
  /** Cascade hops and repair retries, for the Run Detail view. */
  attempts: RouterAttempt[]
}

export interface RouterAttempt {
  model: string
  outcome: 'ok' | 'rate_limited' | 'schema_invalid' | 'error' | 'skipped'
  detail?: string
  latencyMs?: number
}

export interface RouterDeps {
  env: ProviderEnv
  state?: RouterState
  budget?: Budget
  fetcher?: Fetcher
  /** Trace hook — the workflow layer writes these to `agent_events`. */
  onAttempt?: (a: RouterAttempt) => void
}

/**
 * Models sometimes wrap JSON in prose or a fenced block despite JSON mode. Rather
 * than failing the call, extract the object: this is a formatting slip, not a
 * reasoning failure, and spending a repair retry on it wastes a request against a
 * 1,000/day ceiling.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [trimmed]

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))

  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      // try the next shape
    }
  }
  throw new ProviderError(`response was not JSON: ${trimmed.slice(0, 200)}`)
}

/** Zod issues, flattened into the text appended to the repair retry. */
function describeIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .slice(0, 12)
    .join('\n')
}

const DEFAULT_MAX_TOKENS = 2_000

/**
 * The cascade. Walks the ladder for this task class, in live score order, and on
 * each rung allows exactly one schema repair before moving on.
 *
 * The repair policy is §10.3: one retry with the Zod error appended, then escalate
 * the *rung, not the ticket*. Two schema failures on the same model downgrade that
 * model's capability for the rest of the run, because a model that cannot produce
 * the shape twice is telling you something about its capability rather than having
 * bad luck. This is why triage citations are reliable rather than aspirational —
 * `citations.min(1)` turns a hallucination class into a bounded retry.
 *
 * If every rung is exhausted this throws NoCapacityError, which the workflow turns
 * into an ESCALATE with `reason: 'no_capacity'`. Degradation is a first-class
 * outcome; there is no path here that returns garbage or fails silently.
 */
export async function complete<T>(
  opts: CompleteOptions<T>,
  deps: RouterDeps,
): Promise<CompleteResult<T>> {
  const state = deps.state ?? new RouterState()
  const budget = deps.budget ?? new Budget()
  const fetcher = deps.fetcher ?? fetch
  const attempts: RouterAttempt[] = []

  const note = (a: RouterAttempt) => {
    attempts.push(a)
    deps.onAttempt?.(a)
  }

  const promptChars = opts.system.length + opts.messages.reduce((n, m) => n + m.content.length, 0)
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const estimated = estimateTokens('x'.repeat(promptChars)) + maxTokens

  const ladder = laddersFor(opts.task).filter((spec) => {
    if (hasKey(spec.provider, deps.env)) return true
    note({ model: spec.id, outcome: 'skipped', detail: `no ${spec.provider} key` })
    return false
  })

  if (ladder.length === 0) {
    throw new NoCapacityError(
      `no provider configured for task '${opts.task}'`,
      attempts.map((a) => ({ model: a.model, reason: a.detail ?? a.outcome })),
    )
  }

  const ranked = scoreModels(ladder, opts.task, state, estimated)

  for (const { spec, score, reason } of ranked) {
    if (score === 0) {
      note({ model: spec.id, outcome: 'skipped', detail: reason ?? 'unavailable' })
      continue
    }

    // Budget is checked per rung: a cascade hop is still a real request, and the
    // per-ticket ceiling must bound the total rather than each attempt.
    budget.check(estimated)

    let messages = opts.messages
    for (let repair = 0; repair <= 1; repair += 1) {
      const startedAt = Date.now()
      state.reserve(spec.id, estimated)

      try {
        const res = await callProvider(
          {
            spec,
            system: opts.system,
            messages,
            json: opts.task !== 'guard',
            maxTokens,
            temperature: opts.temperature ?? 0.2,
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          deps.env,
          fetcher,
        )

        const tokens = res.promptTokens + res.completionTokens
        const latencyMs = Date.now() - startedAt
        state.settle(spec.id, estimated, tokens)
        budget.spend(tokens)

        const parsed = opts.schema.safeParse(extractJson(res.text))
        if (parsed.success) {
          note({ model: spec.id, outcome: 'ok', latencyMs })
          return { value: parsed.data, model: spec.id, tokens, latencyMs, attempts }
        }

        const failures = state.noteSchemaFailure(spec.id)
        note({
          model: spec.id,
          outcome: 'schema_invalid',
          detail: describeIssues(parsed.error),
          latencyMs,
        })

        // One repair on this rung, and only if the ticket can still afford a call.
        if (repair === 1 || failures >= 2 || budget.remainingCalls === 0) break
        messages = [
          ...messages,
          { role: 'assistant', content: res.text.slice(0, 4_000) },
          {
            role: 'user',
            content: `Your response did not match the required schema:\n${describeIssues(
              parsed.error,
            )}\n\nReturn corrected JSON only. Do not explain the correction.`,
          },
        ]
      } catch (err) {
        if (err instanceof RateLimitError) {
          state.cooldown(spec.id, err.resetAt)
          note({ model: spec.id, outcome: 'rate_limited', detail: err.message })
          break
        }
        // A budget error is not the provider's fault and must not be retried
        // against another rung — the ticket is out of allowance either way.
        if (err instanceof Error && err.name === 'BudgetExceededError') throw err

        state.noteError(spec.id)
        note({
          model: spec.id,
          outcome: 'error',
          detail: err instanceof Error ? err.message : String(err),
        })
        break
      }
    }
  }

  throw new NoCapacityError(
    `every rung exhausted for task '${opts.task}'`,
    attempts.map((a) => ({ model: a.model, reason: a.detail ?? a.outcome })),
  )
}
