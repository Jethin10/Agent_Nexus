export type IntegrationStatus = 'ready' | 'degraded' | 'missing'

export interface IntegrationReadiness {
  id: 'github' | 'database' | 'inngest' | 'models' | 'slack' | 'linear' | 'sandbox' | 'dashboard'
  name: string
  status: IntegrationStatus
  detail: string
  required: readonly string[]
}

/**
 * Configuration-only production readiness. This never returns credential values and
 * never makes a network request, so it is safe to render in the authenticated dashboard.
 * `pnpm integrations:check --strict` performs the corresponding live, read-only probes.
 */
export function integrationReadiness(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IntegrationReadiness[] {
  const githubRepo = has(env, 'GITHUB_OWNER', 'GITHUB_REPO')
  const githubApp = has(env, 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_BASE64')
  const githubAppPartial = Boolean(env.GITHUB_APP_ID) !== Boolean(env.GITHUB_APP_PRIVATE_KEY_BASE64)
  const githubToken = Boolean(
    env.GITHUB_TOKEN && env.ASCENDANT_ALLOW_GITHUB_TOKEN === '1',
  )
  const blockedGithubToken = Boolean(env.GITHUB_TOKEN) && !githubToken
  const githubWebhook = Boolean(env.GITHUB_WEBHOOK_SECRET)
  const githubAccess = (githubApp || githubToken) && !githubAppPartial
  const githubReady = githubRepo && githubAccess && githubWebhook

  const modelProviders = [
    env.GROQ_API_KEY ? 'Groq' : undefined,
    env.GEMINI_API_KEY ? 'Gemini' : undefined,
    env.OPENROUTER_API_KEY ? 'OpenRouter' : undefined,
    env.CEREBRAS_API_KEY ? 'Cerebras' : undefined,
  ].filter((provider): provider is string => Boolean(provider))

  const inngestEvent = Boolean(env.INNGEST_EVENT_KEY)
  const inngestSigning = Boolean(env.INNGEST_SIGNING_KEY)
  const slackOutbound = has(env, 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID')
  const slackSigned = Boolean(env.SLACK_SIGNING_SECRET)
  const linear = has(env, 'LINEAR_API_KEY', 'LINEAR_TEAM_ID')
  const actionsSandbox = githubRepo && githubAccess && Boolean(env.ACTIONS_WORKFLOW)

  return [
    {
      id: 'github',
      name: 'GitHub',
      status: githubReady
        ? 'ready'
        : githubRepo || githubApp || githubToken || blockedGithubToken || githubWebhook
          ? 'degraded'
          : 'missing',
      detail: githubAppPartial
        ? 'GitHub App credentials are incomplete; both values are required.'
        : blockedGithubToken
          ? 'A static GitHub token is present but disabled; production must use GitHub App credentials.'
          : githubReady
          ? `App webhook and ${githubApp ? 'installation-token' : 'local token'} access are configured for ${env.GITHUB_OWNER}/${env.GITHUB_REPO}.`
          : 'Repository access and the signed webhook receiver are both required.',
      required: ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_BASE64'],
    },
    {
      id: 'database',
      name: 'Database',
      status: env.DATABASE_URL ? 'ready' : env.ASCENDANT_LOCAL_DB === '1' ? 'degraded' : 'missing',
      detail: env.DATABASE_URL
        ? 'Neon/Postgres is configured for durable server data.'
        : env.ASCENDANT_LOCAL_DB === '1'
          ? 'PGlite is active for local development; it is not a deployed shared database.'
          : 'A durable Postgres connection is required by the server workflows.',
      required: ['DATABASE_URL'],
    },
    {
      id: 'inngest',
      name: 'Inngest',
      status: inngestEvent && inngestSigning ? 'ready' : inngestEvent || inngestSigning ? 'degraded' : 'missing',
      detail: inngestEvent && inngestSigning
        ? 'Event publishing and signed function execution are configured.'
        : 'Both event and signing keys are required for durable execution.',
      required: ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'],
    },
    {
      id: 'models',
      name: 'Live models',
      status: modelProviders.length > 0 ? 'ready' : 'missing',
      detail: modelProviders.length > 0
        ? `${modelProviders.join(' → ')} available to server workflows.`
        : 'At least one inference provider is required; server workflows never use fixtures.',
      required: ['GROQ_API_KEY or GEMINI_API_KEY or OPENROUTER_API_KEY'],
    },
    {
      id: 'slack',
      name: 'Slack',
      status: slackOutbound && slackSigned ? 'ready' : slackOutbound || slackSigned ? 'degraded' : 'missing',
      detail: slackOutbound && slackSigned
        ? 'Channel notifications and signed human-review actions are configured.'
        : 'Bot/channel access and the interaction signing secret are both required.',
      required: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'SLACK_SIGNING_SECRET'],
    },
    {
      id: 'linear',
      name: 'Linear',
      status: linear ? 'ready' : 'missing',
      detail: linear
        ? 'Accepted work can be mirrored through the delivery lifecycle.'
        : 'A team-scoped API key and team id are required for work-item mirroring.',
      required: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
    },
    {
      id: 'sandbox',
      name: 'Sandbox',
      status: env.E2B_API_KEY ? 'ready' : actionsSandbox || env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1' ? 'degraded' : 'missing',
      detail: env.E2B_API_KEY
        ? 'E2B isolation is configured for generated-code execution.'
        : actionsSandbox
          ? 'GitHub Actions fallback is configured; E2B remains the isolated primary driver.'
          : env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1'
            ? 'The local driver is enabled and must never be used in a public deployment.'
            : 'Configure E2B isolation or the guarded GitHub Actions fallback.',
      required: ['E2B_API_KEY (preferred) or ACTIONS_WORKFLOW with GitHub access'],
    },
    {
      id: 'dashboard',
      name: 'Dashboard gate',
      status: env.ASCENDANT_DASHBOARD_PASSWORD
        ? 'ready'
        : env.ASCENDANT_ALLOW_OPEN_DASHBOARD === '1'
          ? 'degraded'
          : 'missing',
      detail: env.ASCENDANT_DASHBOARD_PASSWORD
        ? 'The operational dashboard is protected by the configured shared secret.'
        : env.ASCENDANT_ALLOW_OPEN_DASHBOARD === '1'
          ? 'The dashboard was deliberately left open; do not use this in production.'
          : 'Production builds require an authenticated dashboard.',
      required: ['ASCENDANT_DASHBOARD_PASSWORD'],
    },
  ]
}

function has(env: Readonly<Record<string, string | undefined>>, ...keys: string[]): boolean {
  return keys.every((key) => Boolean(env[key]))
}
