import type { ModelSpec } from './models.js'

/**
 * The only place in the codebase that knows a provider's wire format. Everything
 * above this file speaks `complete()` and never learns which provider served it —
 * that is what makes the cascade in §10.1 a configuration change rather than a
 * rewrite of seven agents.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ProviderCall {
  spec: ModelSpec
  system: string
  messages: Message[]
  /** JSON mode. Every task except `guard` wants structured output. */
  json: boolean
  maxTokens: number
  temperature: number
  signal?: AbortSignal
}

export interface ProviderResult {
  text: string
  /** Actual usage, so the local estimate can be corrected (see RouterState.settle). */
  promptTokens: number
  completionTokens: number
}

/** A 429, carrying the provider's own reset time when it sent one. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly resetAt?: number,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/** Any other provider-side failure: 5xx, network, malformed response. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/**
 * Every tier exhausted. Never a silent failure: the caller turns this into an
 * ESCALATE with `reason: 'no_capacity'` (§10.1), because a ticket that cannot be
 * processed must land in a human's queue rather than disappearing.
 */
export class NoCapacityError extends Error {
  constructor(
    message: string,
    readonly attempts: { model: string; reason: string }[],
  ) {
    super(message)
    this.name = 'NoCapacityError'
  }
}

export interface ProviderEnv {
  GROQ_API_KEY?: string | undefined
  GEMINI_API_KEY?: string | undefined
  OPENROUTER_API_KEY?: string | undefined
  CEREBRAS_API_KEY?: string | undefined
}

export type Fetcher = typeof fetch

/** Reset headers arrive on 429 but not on success, so this is only read on failure. */
function parseResetAt(res: Response, now: number): number | undefined {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) return now + secs * 1000
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return at
  }
  // Groq: `x-ratelimit-reset-requests: 2.5s` / `7m30s`. OpenRouter: epoch ms.
  for (const h of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset']) {
    const raw = res.headers.get(h)
    if (!raw) continue
    const dur = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw.trim())
    if (dur && (dur[1] || dur[2])) {
      return now + (Number(dur[1] ?? 0) * 60 + Number(dur[2] ?? 0)) * 1000
    }
    const n = Number(raw)
    if (Number.isFinite(n)) return n > 1e11 ? n : now + n * 1000
  }
  return undefined
}

async function readError(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400)
  } catch {
    return res.statusText
  }
}

/**
 * OpenAI-compatible chat completions. Groq, OpenRouter and Cerebras all speak this
 * shape, so one adapter covers three providers and adding a fourth is a base URL.
 */
async function openaiCompatible(
  call: ProviderCall,
  cfg: { baseUrl: string; apiKey: string; extraHeaders?: Record<string, string> },
  fetcher: Fetcher,
): Promise<ProviderResult> {
  const messages: Message[] = call.system
    ? [{ role: 'system', content: call.system }, ...call.messages]
    : call.messages

  const res = await fetcher(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      ...cfg.extraHeaders,
    },
    body: JSON.stringify({
      model: call.spec.model,
      messages,
      temperature: call.temperature,
      max_tokens: call.maxTokens,
      ...(call.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    ...(call.signal ? { signal: call.signal } : {}),
  })

  if (res.status === 429) {
    throw new RateLimitError(
      `${call.spec.id}: rate limited`,
      parseResetAt(res, Date.now()),
    )
  }
  if (!res.ok) {
    throw new ProviderError(`${call.spec.id}: ${res.status} ${await readError(res)}`, res.status)
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = body.choices?.[0]?.message?.content
  if (typeof text !== 'string') {
    throw new ProviderError(`${call.spec.id}: response carried no message content`)
  }
  return {
    text,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
  }
}

/** Gemini's generateContent shape differs enough to need its own adapter. */
async function gemini(
  call: ProviderCall,
  apiKey: string,
  fetcher: Fetcher,
): Promise<ProviderResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${call.spec.model}:generateContent`
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      // The system prompt goes in its own field, which keeps §15.3 layer 2's
      // separation intact on this provider too rather than by convention.
      ...(call.system ? { systemInstruction: { parts: [{ text: call.system }] } } : {}),
      contents: call.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: call.temperature,
        maxOutputTokens: call.maxTokens,
        ...(call.json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    ...(call.signal ? { signal: call.signal } : {}),
  })

  if (res.status === 429) {
    throw new RateLimitError(`${call.spec.id}: rate limited`, parseResetAt(res, Date.now()))
  }
  if (!res.ok) {
    throw new ProviderError(`${call.spec.id}: ${res.status} ${await readError(res)}`, res.status)
  }

  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
  if (!text) throw new ProviderError(`${call.spec.id}: response carried no text`)
  return {
    text,
    promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
  }
}

const BASE_URLS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  cerebras: 'https://api.cerebras.ai/v1',
}

const KEY_FOR: Record<string, keyof ProviderEnv> = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
}

export function hasKey(provider: ModelSpec['provider'], env: ProviderEnv): boolean {
  return Boolean(env[KEY_FOR[provider] as keyof ProviderEnv])
}

/** Dispatch to the right adapter. The only function above this that names a provider. */
export async function callProvider(
  call: ProviderCall,
  env: ProviderEnv,
  fetcher: Fetcher = fetch,
): Promise<ProviderResult> {
  const keyName = KEY_FOR[call.spec.provider]
  const apiKey = keyName ? env[keyName] : undefined
  if (!apiKey) throw new ProviderError(`${call.spec.id}: ${keyName} is not set`)

  if (call.spec.provider === 'gemini') return gemini(call, apiKey, fetcher)

  const baseUrl = BASE_URLS[call.spec.provider]
  if (!baseUrl) throw new ProviderError(`${call.spec.id}: no base URL for ${call.spec.provider}`)

  return openaiCompatible(
    call,
    {
      baseUrl,
      apiKey,
      ...(call.spec.provider === 'openrouter'
        ? {
            extraHeaders: {
              'http-referer': 'https://github.com/ascendant',
              'x-title': 'Ascendant',
            },
          }
        : {}),
    },
    fetcher,
  )
}
