'use server'

import { revalidatePath } from 'next/cache'
import { CONFIG_KEYS, db, writeConfig } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'

/**
 * §5.4 / §16 beat 4 — thresholds live in the `config` table so they can move without a
 * deploy, and the demo drags the autonomy threshold from 0.80 to 0.95 live to show the
 * same decision get routed to a human instead of acted on.
 *
 * Writes are clamped server-side. A threshold outside [0,1] would make `band()`
 * nonsensical, and the number arrives from a form input rather than from code.
 *
 * SECURITY GAP, stated rather than hidden: there is no session check here. Anyone who
 * can reach the deployed URL can lower the autonomy threshold, which is a privilege
 * escalation on the whole pipeline. This is acceptable for a demo on a private URL and
 * is the first thing that must change before it is exposed further.
 */
const NUMERIC: Record<string, { key: string; min: number; max: number; label: string }> = {
  autonomous: { key: CONFIG_KEYS.autonomous, min: 0, max: 1, label: 'autonomy threshold' },
  flagged: { key: CONFIG_KEYS.flagged, min: 0, max: 1, label: 'review floor' },
  injectionCeiling: {
    key: CONFIG_KEYS.injectionCeiling,
    min: 0,
    max: 1,
    label: 'injection confidence ceiling',
  },
  ticketTokens: {
    key: CONFIG_KEYS.ticketTokens,
    min: 1_000,
    max: 500_000,
    label: 'per-ticket token budget',
  },
  ticketLlmCalls: {
    key: CONFIG_KEYS.ticketLlmCalls,
    min: 1,
    max: 200,
    label: 'per-ticket call budget',
  },
  orgDailyTokens: {
    key: CONFIG_KEYS.orgDailyTokens,
    min: 10_000,
    max: 5_000_000,
    label: 'daily org token ceiling',
  },
}

export interface ActionResult {
  ok: boolean
  message: string
}

export async function updatePolicy(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const field = String(form.get('field') ?? '')
  const spec = NUMERIC[field]
  if (!spec) return { ok: false, message: `unknown setting: ${field}` }

  const raw = Number(form.get('value'))
  if (!Number.isFinite(raw)) return { ok: false, message: 'that is not a number' }

  const value = Math.min(spec.max, Math.max(spec.min, raw))

  try {
    await writeConfig(db(), currentOrgId(), spec.key, value, {
      note: `set from the Policy view`,
      updatedBy: 'dashboard',
    })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'the write failed' }
  }

  /**
   * The Inbox and Metrics views read these bands to draw the confidence bars, so both
   * are revalidated — otherwise the demo drags the threshold and nothing visibly moves.
   */
  revalidatePath('/policy')
  revalidatePath('/')
  revalidatePath('/metrics')

  return {
    ok: true,
    message:
      value === raw
        ? `${spec.label} is now ${value}`
        : `${spec.label} clamped to ${value} (allowed range ${spec.min}–${spec.max})`,
  }
}
