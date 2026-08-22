import { db } from '@ascendant/db'
import { integrationReadiness } from '@ascendant/workflows'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

/**
 * Public, credential-safe liveness/readiness endpoint for Vercel and operators.
 * It exposes integration names and states, never environment values or provider errors.
 */
export async function GET(): Promise<Response> {
  const checks = integrationReadiness()
  const configurationReady = checks.every((check) => check.status === 'ready')
  let databaseReady = false

  try {
    await db().execute(sql`select 1`)
    databaseReady = true
  } catch {
    databaseReady = false
  }

  // Render uses this endpoint for liveness. Optional integrations may legitimately be
  // missing before a workspace connects them, but the server is operational as long
  // as its durable database is reachable. Preserve the degraded status in the body
  // for operators while returning 200 so an optional provider cannot take the entire
  // service out of rotation.
  const operational = databaseReady
  const ready = configurationReady && databaseReady
  return Response.json(
    {
      status: ready ? 'ready' : operational ? 'degraded' : 'unavailable',
      database: databaseReady ? 'ready' : 'unavailable',
      integrations: Object.fromEntries(checks.map((check) => [check.id, check.status])),
      timestamp: new Date().toISOString(),
    },
    {
      status: operational ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  )
}
