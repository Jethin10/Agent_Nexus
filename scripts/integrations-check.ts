import { linearWriter } from '@ascendant/connectors'
import { integrationReadiness, repoClient, repoFromEnv } from '@ascendant/workflows'

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
        detail: 'set GITHUB_OWNER, GITHUB_REPO, and GitHub App credentials (or GITHUB_TOKEN locally)',
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

  const configuration = integrationReadiness()
  for (const id of ['database', 'models', 'sandbox', 'inngest', 'dashboard'] as const) {
    const check = configuration.find((item) => item.id === id)
    if (check) checks.push({ name: check.name, status: check.status, detail: check.detail })
  }

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
