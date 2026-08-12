import { linearWriter } from '@ascendant/connectors'
import { repoClient, repoFromEnv } from '@ascendant/workflows'

interface Check {
  name: string
  status: 'ready' | 'missing' | 'failed'
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

  const providers = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'].filter((key) => process.env[key])
  checks.push({
    name: 'Live inference',
    status: providers.length ? 'ready' : 'missing',
    detail: providers.length
      ? `${providers.map((key) => key.replace('_API_KEY', '')).join(' → ')} configured for server workflows`
      : 'set at least one provider key',
  })
  checks.push({
    name: 'Sandbox',
    status: process.env.E2B_API_KEY || process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1' ? 'ready' : 'missing',
    detail: process.env.E2B_API_KEY ? 'E2B configured' : process.env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1' ? 'local demo driver enabled (not isolated)' : 'set E2B_API_KEY; local is demo-only',
  })
  configured('Inngest', process.env.INNGEST_EVENT_KEY, 'set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY')
  configured('Dashboard gate', process.env.ASCENDANT_DASHBOARD_PASSWORD, 'required before deployment')

  process.stdout.write('\nAscendant integration readiness\n\n')
  for (const check of checks) {
    const mark = check.status === 'ready' ? '✓' : check.status === 'missing' ? '○' : '✗'
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
