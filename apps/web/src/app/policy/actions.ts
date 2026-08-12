'use server'

import { revalidatePath } from 'next/cache'
import { CONFIG_KEYS, db, writeConfig } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'

/**
 * Thresholds live in the `config` table so operators can move them without a deploy
 * and route the same confidence score to a human instead of autonomous action.
 *
 * Writes are clamped server-side. A threshold outside [0,1] would make `band()`
 * nonsensical, and the number arrives from a form input rather than from code.
 *
 * Reaching this action at all requires the shared-secret gate in `src/middleware.ts`,
 * which covers Server Action POSTs because they are ordinary requests to a matched path.
 * That closes the escalation where anyone who could load the URL could lower the
 * autonomy threshold. What it is not is per-user authorization: there is one secret and
 * one org, so `updatedBy` below records 'dashboard' rather than a person.
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
    await ensureDb()
    await writeConfig(db(), currentOrgId(), spec.key, value, {
      note: `set from the Policy view`,
      updatedBy: process.env.ASCENDANT_OPERATOR_NAME ?? 'local-dashboard-operator',
    })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'the write failed' }
  }

  /** The Inbox and Metrics views read these bands, so both need fresh server data. */
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
