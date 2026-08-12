import { linearWriter } from '@ascendant/connectors'
import { e2bDriver } from '@ascendant/sandbox'
import { db } from '@ascendant/db'
import { sql } from 'drizzle-orm'
import { embedText, integrationReadiness, repoClient, repoFromEnv } from '@ascendant/workflows'

interface Check {
  name: string
  status: 'ready' | 'degraded' | 'missing' | 'failed'
  detail: string
}

const checks: Check[] = []
const configured = (name: string, value: string | undefined, why: string) => {
  checks.push({ name, status: value ? 'ready' : 'missing', detail: value ? 'configured' : why })
}

async function main() {
  try {
    const repo = await repoFromEnv()
    if (!repo) {
      checks.push({
        name: 'GitHub repository',
        status: 'missing',
        detail: 'set repository + GitHub App credentials (or GITHUB_TOKEN + ASCENDANT_ALLOW_GITHUB_TOKEN=1 locally)',
      })
    } else {
      const sha = await repoClient(repo).headSha()
      checks.push({
        name: 'GitHub repository',
        status: 'ready',
        detail: `${repo.owner}/${repo.repo}@${repo.ref ?? 'main'} (${sha.slice(0, 8)}; ${repo.auth} auth)`,
      })
    }
  } catch (err) {
    checks.push({ name: 'GitHub repository', status: 'failed', detail: message(err) })
  }
  configured('GitHub webhook', process.env.GITHUB_WEBHOOK_SECRET, 'set GITHUB_WEBHOOK_SECRET')

  if (!process.env.LINEAR_API_KEY || !process.env.LINEAR_TEAM_ID) {
    checks.push({ name: 'Linear', status: 'missing', detail: 'set LINEAR_API_KEY and LINEAR_TEAM_ID' })
  } else {
    try {
      const states = await linearWriter({ token: process.env.LINEAR_API_KEY, teamId: process.env.LINEAR_TEAM_ID }).states()
      checks.push({ name: 'Linear', status: 'ready', detail: `${Object.keys(states).length} workflow states visible` })
    } catch (err) {
      checks.push({ name: 'Linear', status: 'failed', detail: message(err) })
    }
  }

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID) {
    checks.push({ name: 'Slack', status: 'missing', detail: 'set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID' })
  } else {
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      })
      const body = await res.json() as { ok?: boolean; team?: string; error?: string }
      if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      checks.push({ name: 'Slack', status: 'ready', detail: `${body.team ?? 'workspace'}; channel ${process.env.SLACK_CHANNEL_ID}` })
    } catch (err) {
      checks.push({ name: 'Slack', status: 'failed', detail: message(err) })
    }
  }
  configured('Slack interactions', process.env.SLACK_SIGNING_SECRET, 'set SLACK_SIGNING_SECRET')
  configured('Slack reviewers', process.env.SLACK_REVIEWER_IDS, 'set SLACK_REVIEWER_IDS')

  const configuration = integrationReadiness()
  for (const id of ['inngest', 'dashboard'] as const) {
    const check = configuration.find((item) => item.id === id)
    if (check) checks.push({ name: check.name, status: check.status, detail: check.detail })
  }

  if (!process.env.DATABASE_URL) {
    checks.push({ name: 'Database', status: 'missing', detail: 'set DATABASE_URL' })
  } else {
    try {
      const result = await db().execute(sql`
        select
          exists(select 1 from pg_extension where extname = 'vector') as vector,
          exists(select 1 from information_schema.tables where table_name = 'events') as migrated
      `)
      const row = (result as unknown as { rows?: { vector?: boolean; migrated?: boolean }[] }).rows?.[0]
      if (!row?.vector || !row.migrated) throw new Error('database is reachable but pgvector or migrations are missing')
      checks.push({ name: 'Database', status: 'ready', detail: 'Postgres, pgvector, and core schema verified' })
    } catch (err) {
      checks.push({ name: 'Database', status: 'failed', detail: message(err) })
    }
  }

  if (!process.env.E2B_API_KEY) {
    checks.push({ name: 'Sandbox', status: 'missing', detail: 'set E2B_API_KEY' })
  } else if (!process.argv.includes('--strict')) {
    checks.push({ name: 'Sandbox', status: 'ready', detail: 'E2B configured; use --strict for a live isolation probe' })
  } else {
    const driver = e2bDriver({
      apiKey: process.env.E2B_API_KEY,
      ...(process.env.E2B_TEMPLATE_ID ? { templateId: process.env.E2B_TEMPLATE_ID } : {}),
    })
    let handle: Awaited<ReturnType<typeof driver.create>> | undefined
    try {
      handle = await driver.create({ image: 'base', timeoutMs: 60_000, env: {} })
      const result = await driver.exec(handle, ['node', '--version'], { timeoutMs: 30_000 })
      if (result.exitCode !== 0) throw new Error(result.stderr || 'sandbox probe failed')
      checks.push({ name: 'Sandbox', status: 'ready', detail: `E2B isolated execution verified (${result.stdout.trim()})` })
    } catch (err) {
      checks.push({ name: 'Sandbox', status: 'failed', detail: message(err) })
    } finally {
      if (handle) await driver.destroy(handle)
    }
  }

  if (!process.env.GEMINI_API_KEY) {
    checks.push({ name: 'Semantic embeddings', status: 'missing', detail: 'set GEMINI_API_KEY' })
  } else {
    try {
      const vector = await embedText({
        apiKey: process.env.GEMINI_API_KEY,
        text: 'Ascendant production readiness probe',
        task: 'RETRIEVAL_QUERY',
      })
      checks.push({ name: 'Semantic embeddings', status: 'ready', detail: `${vector.length} dimensions verified` })
    } catch (err) {
      checks.push({ name: 'Semantic embeddings', status: 'failed', detail: message(err) })
    }
  }
  const reasoning = configuration.find((item) => item.id === 'models')
  if (reasoning) checks.push({ name: 'Live models', status: reasoning.status, detail: reasoning.detail })

  process.stdout.write('\nAscendant integration readiness\n\n')
  for (const check of checks) {
    const mark = check.status === 'ready' ? '✓' : check.status === 'degraded' ? '△' : check.status === 'missing' ? '○' : '✗'
    process.stdout.write(`${mark} ${check.name.padEnd(22)} ${check.status.padEnd(7)} ${check.detail}\n`)
  }
  process.stdout.write('\nNo external records or messages were created by this check.\n')

  if (process.argv.includes('--strict') && checks.some((check) => check.status !== 'ready')) process.exit(1)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

main().catch((err) => {
  process.stderr.write(`${message(err)}\n`)
  process.exit(1)
})
