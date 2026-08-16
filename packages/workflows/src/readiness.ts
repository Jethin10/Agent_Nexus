export type IntegrationStatus = 'ready' | 'degraded' | 'missing'

export interface IntegrationReadiness {
  id: 'github' | 'database' | 'inngest' | 'models' | 'slack' | 'gmail' | 'linear' | 'sandbox' | 'dashboard'
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
  const semanticEmbeddings = Boolean(env.GEMINI_API_KEY)

  const inngestEvent = Boolean(env.INNGEST_EVENT_KEY)
  const inngestSigning = Boolean(env.INNGEST_SIGNING_KEY)
  const slackOutbound = has(env, 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID')
  const slackSigned = Boolean(env.SLACK_SIGNING_SECRET)
  const slackReviewers = Boolean(env.SLACK_REVIEWER_IDS?.split(',').some((id) => id.trim()))
  const slackInbound = Boolean(env.SLACK_INGEST_CHANNEL_IDS || env.SLACK_INGEST_CHANNEL_ID || env.SLACK_CHANNEL_ID)
  const gmail = has(env, 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN')
  const gmailPartial = Boolean(env.GMAIL_CLIENT_ID || env.GMAIL_CLIENT_SECRET || env.GMAIL_REFRESH_TOKEN) && !gmail
  const linear = has(env, 'LINEAR_API_KEY', 'LINEAR_TEAM_ID')

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
      status: modelProviders.length > 0 && semanticEmbeddings
        ? 'ready'
        : modelProviders.length > 0
          ? 'degraded'
          : 'missing',
      detail: modelProviders.length > 0 && semanticEmbeddings
        ? `${modelProviders.join(' → ')} available; Gemini semantic retrieval is enabled.`
        : modelProviders.length > 0
          ? `${modelProviders.join(' → ')} can reason, but GEMINI_API_KEY is required for semantic retrieval.`
          : 'At least one inference provider plus Gemini embeddings is required; server workflows never use fixtures.',
      required: ['GEMINI_API_KEY', 'GROQ_API_KEY or GEMINI_API_KEY or OPENROUTER_API_KEY'],
    },
    {
      id: 'slack',
      name: 'Slack',
      status: slackOutbound && slackSigned && slackReviewers && slackInbound
        ? 'ready'
        : slackOutbound || slackSigned || slackReviewers || slackInbound
          ? 'degraded'
          : 'missing',
      detail: slackOutbound && slackSigned && slackReviewers && slackInbound
        ? 'Signed message ingestion, bounded history sync, notifications, and reviewer actions are configured.'
        : 'Bot/channel access, an ingest channel, signing secret, and reviewer allowlist are required.',
      required: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'SLACK_INGEST_CHANNEL_ID(S)', 'SLACK_SIGNING_SECRET', 'SLACK_REVIEWER_IDS'],
    },
    {
      id: 'gmail',
      name: 'Gmail context',
      status: gmail ? 'ready' : gmailPartial ? 'degraded' : 'missing',
      detail: gmail
        ? `Read-only history sync is configured${env.GMAIL_QUERY ? ` for query “${env.GMAIL_QUERY}”` : ' for the label:ascendant safety scope'}.`
        : gmailPartial
          ? 'Gmail OAuth is incomplete; client id, client secret, and refresh token are all required.'
          : 'Configure read-only OAuth to import a bounded, explicitly filtered email history.',
      required: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_QUERY'],
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
      status: env.E2B_API_KEY ? 'ready' : env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1' ? 'degraded' : 'missing',
      detail: env.E2B_API_KEY
        ? 'E2B isolation is configured for generated-code execution.'
        : env.ASCENDANT_ALLOW_LOCAL_SANDBOX === '1'
            ? 'The local driver is enabled and must never be used in a public deployment.'
            : 'Configure E2B isolation for generated-code execution.',
      required: ['E2B_API_KEY'],
    },
    {
      id: 'dashboard',
      name: 'Dashboard gate',
      status: env.ASCENDANT_DASHBOARD_PASSWORD && env.ASCENDANT_OPERATOR_NAME
        ? 'ready'
        : env.ASCENDANT_ALLOW_OPEN_DASHBOARD === '1'
          ? 'degraded'
          : 'missing',
      detail: env.ASCENDANT_DASHBOARD_PASSWORD && env.ASCENDANT_OPERATOR_NAME
        ? `The operational dashboard is protected and actions are attributed to ${env.ASCENDANT_OPERATOR_NAME}.`
        : env.ASCENDANT_ALLOW_OPEN_DASHBOARD === '1'
          ? 'The dashboard was deliberately left open; do not use this in production.'
          : 'Production builds require an authenticated dashboard.',
      required: ['ASCENDANT_DASHBOARD_PASSWORD', 'ASCENDANT_OPERATOR_NAME'],
    },
  ]
}

function has(env: Readonly<Record<string, string | undefined>>, ...keys: string[]): boolean {
  return keys.every((key) => Boolean(env[key]))
}
