import { db } from '@ascendant/db'
import {
  connectionAwareIntegrationReadiness,
  connectionSummaries,
  integrationReadiness,
} from '@ascendant/workflows'
import { sql } from 'drizzle-orm'
import { currentOrgId } from '../../../lib/org.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

/**
 * Public, credential-safe liveness/readiness endpoint for Vercel and operators.
 * It exposes integration names and states, never environment values or provider errors.
 */
export async function GET(): Promise<Response> {
  let checks = integrationReadiness()
  let databaseReady = false

  try {
    const database = db()
    await database.execute(sql`select 1`)
    databaseReady = true
    try {
      const summaries = await connectionSummaries(database, currentOrgId())
      const github = summaries.find((summary) => summary.provider === 'github')
      const slack = summaries.find((summary) => summary.provider === 'slack')
      checks = connectionAwareIntegrationReadiness({
        ...(github ? { github: { repositorySelected: Boolean(github.owner && github.repo) } } : {}),
        ...(slack ? { slack: { reviewerConfigured: Boolean(slack.reviewerCount) } } : {}),
        ...(summaries.some((summary) => summary.provider === 'gmail') ? { gmail: true } : {}),
      })
    } catch {
      // A corrupt or rotated connection grant degrades that provider without turning a
      // successful database liveness probe into a service-wide outage.
    }
  } catch {
    databaseReady = false
  }

  const configurationReady = checks.every((check) => check.status === 'ready')

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
