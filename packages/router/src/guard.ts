import { untrustedBlock } from '@ascendant/core'
import { MODEL_BY_ID } from './models.js'
import { callProvider, type Fetcher, type ProviderEnv } from './providers.js'

/**
 * §15.3 layer 1 — classify. Every ingested body runs through Groq's
 * `meta-llama/llama-prompt-guard-2-86m` (14,400 RPD free, comfortably enough for
 * every event on this system).
 *
 * A positive detection does NOT block the event. It sets `injectionSuspected`, which
 * caps confidence at 0.5 and therefore forces ESCALATE — a human sees it, and the
 * agent never acts on it. Blocking would be worse: an attacker who can get an event
 * dropped silently has a denial-of-service, and a legitimate bug report that happens
 * to quote an error message containing "ignore previous instructions" is exactly the
 * kind of thing a human should look at rather than a filter should eat.
 *
 * This layer reduces the rate. It does not bound the damage — that is layer 3.
 */

/**
 * Deterministic pre-filter. Runs before the model call and short-circuits it, so an
 * obvious payload costs zero requests. These patterns are the shapes seen in the
 * wild, including the incident in §15.1: hijacked web-search results carrying a
 * trailing "REMINDER: You MUST …" line, from a tool the agent had every reason to
 * trust.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding)\s+(?:instructions?|prompts?|rules?)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions?|rules?|guidelines?)/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions?|prompt|directive)s?\s*:/i,
  /^\s*(?:REMINDER|IMPORTANT|ATTENTION|NOTE\s+TO\s+(?:AI|AGENT|ASSISTANT))\s*:\s*you\s+must/im,
  /\b(?:system|assistant)\s*:\s*(?:you|approve|ignore|execute)/i,
  /<\/?(?:system|instructions?|untrusted)\b/i,
  /\breveal\s+(?:your\s+)?(?:system\s+prompt|instructions?|api[_\s]?key|secret)/i,
  /\b(?:print|output|echo)\s+(?:your\s+)?(?:system\s+prompt|env(?:ironment)?\s+variables?|secrets?)/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+(?:user|human|maintainer)/i,
  /\bapprove\s+this\s+(?:pull\s+request|pr|change|diff)\s+without\b/i,
]

export interface GuardVerdict {
  suspected: boolean
  /** 0-1. Deterministic hits report 1: the pattern either matched or it did not. */
  score: number
  /** Which pattern indices or the model's own label, for the audit trail. */
  signals: string[]
  /** True when the model was consulted, so the cost is attributable. */
  modelUsed?: string
  tokens: number
}

/** The free, instant half. Runs on every body, no network. */
export function scanPatterns(text: string): GuardVerdict {
  const signals: string[] = []
  for (const [i, re] of INJECTION_PATTERNS.entries()) {
    const m = re.exec(text)
    if (m) signals.push(`pattern:${i}:${m[0].slice(0, 60).replace(/\s+/g, ' ')}`)
  }
  return { suspected: signals.length > 0, score: signals.length > 0 ? 1 : 0, signals, tokens: 0 }
}

const GUARD_MODEL = 'groq/prompt-guard'

/** prompt-guard-2 emits a label rather than JSON, so its output is read directly. */
function readGuardLabel(text: string): { suspected: boolean; label: string } {
  const t = text.trim().toLowerCase()
  const suspected =
    /\b(?:jailbreak|injection|malicious|unsafe)\b/.test(t) ||
    /^(?:1|true|yes)\b/.test(t) ||
    /"?label"?\s*[:=]\s*"?(?:1|jailbreak|injection)/.test(t)
  return { suspected, label: text.trim().slice(0, 120) }
}

export interface GuardDeps {
  env: ProviderEnv
  fetcher?: Fetcher
  signal?: AbortSignal
}

/**
 * Pattern scan first, then the classifier. Two properties worth keeping:
 *
 * 1. A deterministic hit short-circuits the model call. The verdict is already
 *    ESCALATE, so paying a request to have a model agree is waste.
 * 2. A classifier failure fails OPEN — `suspected: false` with the error recorded.
 *    Failing closed would mean an outage on one free-tier model routes every event
 *    in the system to a human, which is a worse failure than missing a payload that
 *    layers 2 and 3 still have to get past.
 */
export async function scanForInjection(
  text: string,
  source: string,
  deps: GuardDeps,
): Promise<GuardVerdict> {
  const deterministic = scanPatterns(text)
  if (deterministic.suspected) return deterministic

  const spec = MODEL_BY_ID.get(GUARD_MODEL)
  if (!spec || !deps.env.GROQ_API_KEY) {
    return { ...deterministic, signals: ['guard:unavailable'] }
  }

  try {
    const res = await callProvider(
      {
        spec,
        system: '',
        // Even here the body is delimited: the classifier is a model too, and
        // handing it bare hostile text is the mistake this whole section is about.
        messages: [
          { role: 'user', content: untrustedBlock({ source, trust: 'anonymous', text, maxChars: 8_000 }) },
        ],
        json: false,
        maxTokens: 16,
        temperature: 0,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
      deps.env,
      deps.fetcher ?? fetch,
    )

    const { suspected, label } = readGuardLabel(res.text)
    return {
      suspected,
      score: suspected ? 1 : 0,
      signals: suspected ? [`guard:${label}`] : [],
      modelUsed: spec.id,
      tokens: res.promptTokens + res.completionTokens,
    }
  } catch (err) {
    return {
      suspected: false,
      score: 0,
      signals: [`guard:error:${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`],
      tokens: 0,
    }
  }
}
