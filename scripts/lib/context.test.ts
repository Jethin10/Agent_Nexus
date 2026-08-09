import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelMode } from './context.ts'

/**
 * Live inference is opt-in, not implied by a key being present.
 *
 * The ladder's triage rungs are Groq at capability 0.95; the OpenRouter rung is a 0.8
 * fallback sized for overflow. A shell holding only OPENROUTER_API_KEY used to count as
 * fully live and ran every scenario on the weakest rung, losing two of the five beats —
 * so a valid key produced a worse demo than no key at all. These tests pin the
 * precedence so that regression cannot come back silently.
 */

const KEYS = [
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'CEREBRAS_API_KEY',
  'ASCENDANT_LIVE',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('modelMode', () => {
  it('defaults to fixtures when nothing is configured', () => {
    expect(modelMode().kind).toBe('fixture')
  })

  it('stays on fixtures when a key is set but live was never requested', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    const mode = modelMode()
    expect(mode.kind).toBe('fixture')
    // The label has to tell the operator the key was seen and deliberately not used,
    // otherwise this looks like the key is broken.
    expect(mode.label).toContain('ASCENDANT_LIVE=1')
  })

  it('goes live only when the opt-in and a key are both present', () => {
    process.env.ASCENDANT_LIVE = '1'
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    const mode = modelMode()
    expect(mode.kind).toBe('live')
    expect(mode.label).toContain('OpenRouter')
  })

  it('falls back to fixtures when live is requested with no key at all', () => {
    process.env.ASCENDANT_LIVE = '1'
    const mode = modelMode()
    expect(mode.kind).toBe('fixture')
    expect(mode.label).toContain('no provider key')
  })

  it('names every configured provider in ladder order', () => {
    process.env.ASCENDANT_LIVE = '1'
    process.env.GROQ_API_KEY = 'gsk-test'
    process.env.GEMINI_API_KEY = 'gm-test'
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    expect(modelMode().label).toContain('Groq → Gemini → OpenRouter')
  })

  it('treats any value other than exactly "1" as not opting in', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.ASCENDANT_LIVE = v
      expect(modelMode().kind).toBe('fixture')
    }
  })
})
