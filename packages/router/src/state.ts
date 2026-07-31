import { MODELS, type ModelSpec, type TaskClass } from './models.js'

/**
 * §10.2 — rung selection. Not round-robin:
 *
 *   score = available(model)                        // not in cooldown from a 429
 *         × fits(estimatedTokens, tpmRemaining)
 *         × capability(task, model)                 // static table
 *         / expectedLatencyMs
 *
 * Remaining quota is estimated locally from counted usage rather than read from
 * headers, because Groq and OpenRouter send reset headers on 429 but not on
 * success — so there is no authoritative remaining figure to read on the happy
 * path. Counting locally is less accurate and always available, which is the right
 * trade when the alternative is discovering the ceiling by hitting it.
 */

export interface ModelState {
  /** Rolling counters, reset by the window helpers below. */
  requestsThisMinute: number
  requestsToday: number
  tokensThisMinute: number
  tokensToday: number
  minuteStart: number
  dayStart: number
  /** Epoch ms until which a 429 has this model benched. */
  cooldownUntil: number
  /**
   * Per-run capability penalty. Two schema failures on the same model is treated as
   * a capability signal (§10.3), not as bad luck, so it stops being chosen for that
   * task class rather than being retried into the ground.
   */
  schemaFailures: number
  consecutiveErrors: number
}

function freshState(now: number): ModelState {
  return {
    requestsThisMinute: 0,
    requestsToday: 0,
    tokensThisMinute: 0,
    tokensToday: 0,
    minuteStart: now,
    dayStart: now,
    cooldownUntil: 0,
    schemaFailures: 0,
    consecutiveErrors: 0,
  }
}

const MINUTE = 60_000
const DAY = 24 * 60 * 60 * 1000

/**
 * In-memory model state. Deliberately per-process rather than in Postgres: this is
 * a hint for choosing a rung, not an accounting record, and a serverless function
 * that starts cold simply begins optimistic and corrects on the first 429. The
 * authoritative daily spend lives in `agent_events` (see spendToday) and is what
 * the org ceiling checks.
 */
export class RouterState {
  private readonly states = new Map<string, ModelState>()

  constructor(private readonly now: () => number = Date.now) {}

  get(modelId: string): ModelState {
    const t = this.now()
    let s = this.states.get(modelId)
    if (!s) {
      s = freshState(t)
      this.states.set(modelId, s)
    }
    if (t - s.minuteStart >= MINUTE) {
      s.minuteStart = t
      s.requestsThisMinute = 0
      s.tokensThisMinute = 0
    }
    if (t - s.dayStart >= DAY) {
      s.dayStart = t
      s.requestsToday = 0
      s.tokensToday = 0
      s.schemaFailures = 0
    }
    return s
  }

  /** Called before a request so a burst cannot oversubscribe a per-minute ceiling. */
  reserve(modelId: string, estimatedTokens: number): void {
    const s = this.get(modelId)
    s.requestsThisMinute += 1
    s.requestsToday += 1
    s.tokensThisMinute += estimatedTokens
    s.tokensToday += estimatedTokens
  }

  /** Correct the estimate once the provider reports real usage. */
  settle(modelId: string, estimatedTokens: number, actualTokens: number): void {
    const s = this.get(modelId)
    const delta = actualTokens - estimatedTokens
    s.tokensThisMinute = Math.max(0, s.tokensThisMinute + delta)
    s.tokensToday = Math.max(0, s.tokensToday + delta)
    s.consecutiveErrors = 0
  }

  /**
   * 429 → cooldown until the provider's own reset time. Both Groq and OpenRouter
   * send a reset header on 429; when they do not, back off for the rest of the
   * minute window rather than guessing a number.
   */
  cooldown(modelId: string, until?: number): void {
    const s = this.get(modelId)
    s.cooldownUntil = until ?? this.now() + MINUTE
  }

  noteSchemaFailure(modelId: string): number {
    const s = this.get(modelId)
    s.schemaFailures += 1
    return s.schemaFailures
  }

  noteError(modelId: string): number {
    const s = this.get(modelId)
    s.consecutiveErrors += 1
    // Three transient failures in a row is a provider problem, not a request
    // problem: bench it briefly so the cascade moves on instead of retrying a
    // model that is down.
    if (s.consecutiveErrors >= 3) s.cooldownUntil = this.now() + 30_000
    return s.consecutiveErrors
  }

  available(modelId: string): boolean {
    return this.get(modelId).cooldownUntil <= this.now()
  }

  snapshot(): Record<string, ModelState> {
    for (const m of MODELS) this.get(m.id)
    return Object.fromEntries([...this.states].map(([k, v]) => [k, { ...v }]))
  }
}

/**
 * `fits()` from §10.2. Returns 0 when a request cannot fit the remaining per-minute
 * token allowance, and tapers as the window fills so a nearly-full model loses to an
 * empty sibling before it starts returning 429s.
 */
export function fits(spec: ModelSpec, s: ModelState, estimatedTokens: number): number {
  if (s.requestsThisMinute > spec.rpm) return 0
  if (s.requestsToday >= spec.rpd) return 0
  if (s.tokensToday + estimatedTokens > spec.tpd) return 0
  const remaining = spec.tpm - s.tokensThisMinute
  if (estimatedTokens > remaining) return 0
  return Math.min(1, remaining / spec.tpm)
}

export interface ScoredModel {
  spec: ModelSpec
  score: number
  /** Why a model scored 0, for the dashboard's quota banner. */
  reason?: string
}

/** Two schema failures on one model halves its capability for this run (§10.3). */
function effectiveCapability(spec: ModelSpec, task: TaskClass, s: ModelState): number {
  const base = spec.capability[task] ?? 0
  if (s.schemaFailures >= 2) return base * 0.25
  if (s.schemaFailures === 1) return base * 0.7
  return base
}

export function scoreModels(
  candidates: readonly ModelSpec[],
  task: TaskClass,
  state: RouterState,
  estimatedTokens: number,
): ScoredModel[] {
  return candidates
    .map((spec) => {
      const s = state.get(spec.id)
      if (!state.available(spec.id)) return { spec, score: 0, reason: 'cooldown' }
      const f = fits(spec, s, estimatedTokens)
      if (f === 0) return { spec, score: 0, reason: 'quota' }
      const cap = effectiveCapability(spec, task, s)
      if (cap === 0) return { spec, score: 0, reason: 'incapable' }
      return { spec, score: (f * cap * (spec.scarcity ?? 1)) / (spec.latencyMs / 1000) }
    })
    .sort((a, b) => b.score - a.score)
}
