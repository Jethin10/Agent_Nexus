/**
 * Whether a build is publishing the dashboard somewhere other people can reach it.
 *
 * Extracted from `next.config.ts` so it can be tested. The distinction it draws is
 * deploy vs. local build, not production vs. development: `next build` is also how you
 * check that a change compiles — `pnpm build` and `pnpm web:build` are both documented
 * commands — and a build that emits into `.next/` on a laptop publishes nothing.
 *
 * An earlier version keyed off `NODE_ENV === 'production'`, which `next build` sets
 * itself, so it failed `pnpm build` in a fresh clone. That is the regression these tests
 * exist to prevent: a guard that blocks the documented verification command teaches
 * people to work around it, and a worked-around guard protects nothing.
 *
 * CI is deliberately absent from the markers. A pull-request build has no dashboard to
 * expose, and treating it as a deploy would force the secret into repository settings to
 * make the test job green — sharing it with everyone who can read a workflow log.
 */
export const DEPLOY_MARKERS = ['VERCEL', 'NETLIFY', 'CF_PAGES', 'RENDER'] as const

export interface GuardEnv {
  readonly [key: string]: string | undefined
}

export function isDeployment(env: GuardEnv): boolean {
  return DEPLOY_MARKERS.some((m) => Boolean(env[m]))
}

/**
 * True when this build would publish an unauthenticated dashboard.
 *
 * `/policy` writes the autonomy threshold that `band()` reads on every decision, so an
 * open dashboard is privilege escalation on the pipeline rather than a data leak.
 */
export function shouldBlockBuild(env: GuardEnv): boolean {
  if (!isDeployment(env)) return false
  if (env.ASCENDANT_ALLOW_OPEN_DASHBOARD === '1') return false
  return !env.ASCENDANT_DASHBOARD_PASSWORD
}

export const REQUIRED_DEPLOYMENT_ENV = [
  'DATABASE_URL',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY_BASE64',
  'GITHUB_WEBHOOK_SECRET',
  'GEMINI_API_KEY',
  'E2B_API_KEY',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'OAUTH_STATE_SECRET',
  'ASCENDANT_CONNECTIONS_KEY',
  'ASCENDANT_OPERATOR_NAME',
  'ASCENDANT_ORG_ID',
] as const

/** Core server data and workflow authentication must never degrade silently in a deploy. */
export function missingDeploymentRuntimeConfig(env: GuardEnv): string[] {
  if (!isDeployment(env)) return []
  return REQUIRED_DEPLOYMENT_ENV.filter((key) => !env[key])
}

export const OPEN_DASHBOARD_ERROR =
  'ASCENDANT_DASHBOARD_PASSWORD is not set.\n\n' +
  'The Policy view writes the autonomy threshold that gates autonomous action, so an\n' +
  'unauthenticated deploy is a privilege escalation on the whole pipeline: lower the\n' +
  'threshold and work that should have stopped for a human ships on its own.\n\n' +
  'Set it in the deployment environment, or set ASCENDANT_ALLOW_OPEN_DASHBOARD=1 to\n' +
  'deploy without auth on purpose.'
