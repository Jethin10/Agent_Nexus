import { and, eq, inArray } from 'drizzle-orm'
import { CONFIDENCE, LIMITS, type ConfidenceBands } from '@ascendant/core'
import type { Db } from '../client'
import { config } from '../schema/config'

/**
 * Policy is read from the `config` table, never from the constants in
 * @ascendant/core — those are only defaults for a fresh org.
 *
 * This matters concretely: §16 beat 4 drags the autonomy threshold from 0.80 to
 * 0.95 in the Policy view and re-runs the same issue to show the decision hold
 * while the routing changes. A hardcoded read of CONFIDENCE.AUTONOMOUS breaks that
 * demo, and more importantly it means the deployed system's behaviour cannot be
 * corrected without a redeploy.
 */
export const CONFIG_KEYS = {
  autonomous: 'confidence.autonomous',
  flagged: 'confidence.flagged',
  injectionCeiling: 'confidence.injectionCeiling',
  internalActors: 'actors.internal',
  knownExternalActors: 'actors.knownExternal',
  botHandles: 'actors.bots',
  ticketTokens: 'budget.ticketTokens',
  ticketLlmCalls: 'budget.ticketLlmCalls',
  orgDailyTokens: 'budget.orgDailyTokens',
} as const

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS]

/** A 5-second cache: the router reads policy on every call and Neon Free bills CU-hours. */
const TTL_MS = 5_000
const cache = new Map<string, { at: number; rows: Map<string, unknown> }>()

export function invalidateConfigCache(orgId?: string): void {
  if (orgId) cache.delete(orgId)
  else cache.clear()
}

async function load(db: Db, orgId: string): Promise<Map<string, unknown>> {
  const hit = cache.get(orgId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows
  const rows = await db
    .select({ key: config.key, value: config.value })
    .from(config)
    .where(eq(config.orgId, orgId))
  const map = new Map<string, unknown>(rows.map((r) => [r.key, r.value]))
  cache.set(orgId, { at: Date.now(), rows: map })
  return map
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export interface Policy {
  bands: ConfidenceBands
  internalActors: string[]
  knownExternalActors: string[]
  botHandles: string[]
  ticketTokens: number
  ticketLlmCalls: number
  orgDailyTokens: number
}

/**
 * The full policy for an org, defaults filled in from @ascendant/core. One query,
 * cached for 5s, so a whole triage run reads it once in practice.
 */
export async function readPolicy(db: Db, orgId: string): Promise<Policy> {
  const c = await load(db, orgId)
  return {
    bands: {
      autonomous: num(c.get(CONFIG_KEYS.autonomous), CONFIDENCE.AUTONOMOUS),
      flagged: num(c.get(CONFIG_KEYS.flagged), CONFIDENCE.FLAGGED),
      injectionCeiling: num(c.get(CONFIG_KEYS.injectionCeiling), CONFIDENCE.INJECTION_CEILING),
    },
    internalActors: strs(c.get(CONFIG_KEYS.internalActors)),
    knownExternalActors: strs(c.get(CONFIG_KEYS.knownExternalActors)),
    botHandles: strs(c.get(CONFIG_KEYS.botHandles)),
    ticketTokens: num(c.get(CONFIG_KEYS.ticketTokens), LIMITS.MAX_TICKET_TOKENS),
    ticketLlmCalls: num(c.get(CONFIG_KEYS.ticketLlmCalls), LIMITS.MAX_TICKET_LLM_CALLS),
    orgDailyTokens: num(c.get(CONFIG_KEYS.orgDailyTokens), LIMITS.MAX_ORG_DAILY_TOKENS),
  }
}

/** Raw read for keys outside the Policy shape (router model state, feature flags). */
export async function readConfig<T>(db: Db, orgId: string, key: string, fallback: T): Promise<T> {
  const c = await load(db, orgId)
  const v = c.get(key)
  return v === undefined || v === null ? fallback : (v as T)
}

/**
 * Upsert one key. `note` and `updatedBy` are recorded so a surprising threshold
 * has an explanation attached rather than being an unexplained number.
 */
export async function writeConfig(
  db: Db,
  orgId: string,
  key: string,
  value: unknown,
  meta: { note?: string; updatedBy?: string } = {},
): Promise<void> {
  await db
    .insert(config)
    .values({
      orgId,
      key,
      value: value as never,
      note: meta.note ?? null,
      updatedBy: meta.updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [config.orgId, config.key],
      set: {
        value: value as never,
        note: meta.note ?? null,
        updatedBy: meta.updatedBy ?? null,
        updatedAt: new Date(),
      },
    })
  invalidateConfigCache(orgId)
}

/** For the Policy view: every row, so the UI shows what is set vs defaulted. */
export async function listConfig(db: Db, orgId: string, keys?: readonly string[]) {
  const where = keys?.length
    ? and(eq(config.orgId, orgId), inArray(config.key, [...keys]))
    : eq(config.orgId, orgId)
  return db.select().from(config).where(where).orderBy(config.key)
}
