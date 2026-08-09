/**
 * §10.1 — the cascade ladder, with the published free-tier numbers that shape it.
 *
 * Groq's limits are per ORGANIZATION, not per key: a second key buys nothing. What
 * does buy headroom is spreading across *models*, since limits are per-model — which
 * is why the ladder lists sibling models on the same provider before changing
 * provider. That ordering is the whole reason this file is a table rather than a
 * hardcoded fallback chain.
 */
export type Provider = 'groq' | 'gemini' | 'openrouter' | 'cerebras'

export type TaskClass =
  | 'triage'
  | 'plan'
  | 'code'
  | 'review'
  | 'qa'
  | 'summarize'
  | 'classify'
  | 'guard'

export interface ModelSpec {
  id: string
  provider: Provider
  /** Provider-side model name, which differs from our id for OpenRouter's `:free`. */
  model: string
  /** Requests per day, free tier. The real binding ceiling (§13.4). */
  rpd: number
  /** Requests per minute. */
  rpm: number
  /** Tokens per minute — what makes a 6k-token retrieval block a real constraint. */
  tpm: number
  /** Tokens per day. */
  tpd: number
  /** Rough expected latency, used by the rung score's denominator. */
  latencyMs: number
  /** 0-1 per task class. Absent = not a candidate for that task. */
  capability: Partial<Record<TaskClass, number>>
  /**
   * Scarcity multiplier, 0-1. Default 1 for a renewing free tier.
   *
   * §10.2's score rewards low latency, and the fastest model on the ladder is
   * Cerebras — which is a $5 *one-time* credit, not a recurring allowance (§13.6).
   * Without this, the router would rationally spend the demo's burst budget on
   * ordinary traffic and find it empty when it matters. Scarcity is a property of
   * the billing model, so it belongs in the table rather than in the formula.
   */
  scarcity?: number
}

/**
 * Ordered ladder. Position matters only as a tiebreak — the live score in
 * `score()` decides, so a model in cooldown from a 429 is skipped rather than
 * blocking everything behind it.
 */
export const MODELS: readonly ModelSpec[] = [
  {
    id: 'groq/llama-3.3-70b',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    rpd: 1_000,
    rpm: 30,
    tpm: 12_000,
    tpd: 100_000,
    latencyMs: 1_800,
    capability: { triage: 0.95, plan: 0.9, review: 0.9, qa: 0.85, code: 0.75, summarize: 0.8 },
  },
  {
    id: 'groq/gpt-oss-120b',
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    rpd: 1_000,
    rpm: 30,
    tpm: 8_000,
    tpd: 200_000,
    latencyMs: 2_400,
    capability: { triage: 0.9, plan: 0.88, review: 0.88, qa: 0.82, code: 0.85, summarize: 0.8 },
  },
  {
    id: 'gemini/2.5-flash',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    /**
     * Gemini's per-model free RPM/TPM/RPD are not published — they are visible only
     * in AI Studio while signed in, they are per project rather than per key, they
     * reset at midnight Pacific, and the docs say limits are not guaranteed. These
     * are conservative guesses, which is exactly why nothing critical depends on
     * this rung: it serves overflow and large context, never triage's primary path.
     */
    rpd: 200,
    rpm: 10,
    tpm: 250_000,
    tpd: 1_000_000,
    latencyMs: 3_000,
    capability: { triage: 0.85, plan: 0.85, review: 0.82, qa: 0.8, code: 0.8, summarize: 0.9 },
  },
  {
    id: 'openrouter/free',
    provider: 'openrouter',
    /**
     * OpenRouter retires `:free` slugs without notice — `meta-llama/llama-3.3-70b-
     * instruct:free` now 404s with "use the paid slug instead", which the router
     * correctly reported as no capacity while looking like a broken key. Verified
     * against `GET /api/v1/models` and a live JSON-mode call on 2026-08-09.
     *
     * `response_format: json_object` support is the binding requirement, not context or
     * capability: the triage schema is enforced through it, and several free models
     * accept the field and then emit prose anyway (gpt-oss-20b returns empty, the nano
     * tier narrates the request back). Re-check this slug if the gate starts escalating
     * with `no_capacity` on a key that authenticates.
     */
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    /** 50 RPD until $10 lifetime spend, then 1,000. Assume the worse case (§13.5). */
    rpd: 50,
    rpm: 20,
    tpm: 20_000,
    tpd: 100_000,
    latencyMs: 5_000,
    capability: { triage: 0.8, plan: 0.78, review: 0.78, qa: 0.75, code: 0.75, summarize: 0.75 },
  },
  {
    id: 'cerebras/llama-3.3-70b',
    provider: 'cerebras',
    model: 'llama-3.3-70b',
    /** $5 one-time credit. Demo burst only — deliberately last. */
    rpd: 100,
    rpm: 10,
    tpm: 60_000,
    tpd: 300_000,
    latencyMs: 900,
    capability: { triage: 0.9, plan: 0.85, review: 0.85, qa: 0.8, code: 0.8 },
    /** Burn-down credit: last resort, however fast it is. */
    scarcity: 0.05,
  },
  {
    id: 'groq/llama-3.1-8b',
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    /** 14,400 RPD absorbs all the cheap work so the 70b budget goes to real reasoning. */
    rpd: 14_400,
    rpm: 30,
    tpm: 6_000,
    tpd: 500_000,
    latencyMs: 500,
    capability: { classify: 0.8, summarize: 0.75 },
  },
  {
    id: 'groq/prompt-guard',
    provider: 'groq',
    model: 'meta-llama/llama-prompt-guard-2-86m',
    rpd: 14_400,
    rpm: 30,
    tpm: 20_000,
    tpd: 500_000,
    latencyMs: 200,
    capability: { guard: 1 },
  },
]

export const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]))

/** Candidates for a task, best static capability first. */
export function laddersFor(task: TaskClass): ModelSpec[] {
  return MODELS.filter((m) => (m.capability[task] ?? 0) > 0).sort(
    (a, b) => (b.capability[task] ?? 0) - (a.capability[task] ?? 0),
  )
}
