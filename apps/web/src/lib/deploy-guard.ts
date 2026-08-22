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
  if (env.ASCENDANT_DEMO_MODE === '1') return false
  if (env.ASCENDANT_ALLOW_OPEN_DASHBOARD === '1') return false
  return !env.ASCENDANT_DASHBOARD_PASSWORD
}

export const REQUIRED_DEPLOYMENT_ENV = [
  'DATABASE_URL',
  'OAUTH_STATE_SECRET',
  'ASCENDANT_CONNECTIONS_KEY',
  'ASCENDANT_OPERATOR_NAME',
  'ASCENDANT_ORG_ID',
  'ASCENDANT_PUBLIC_URL',
] as const

/**
 * Only configuration required to boot the control plane belongs here.
 *
 * Provider credentials are intentionally optional at build time. A workspace starts
 * with zero connected providers and gains grants through the one-click OAuth routes;
 * failing the whole deploy because Slack, Google, GitHub, Inngest, a model, or a
 * sandbox has not been configured yet turns a recoverable readiness state into an
 * outage. `integrationReadiness()` and each provider route still fail closed and name
 * the missing configuration without exposing values.
 */
export function missingDeploymentRuntimeConfig(env: GuardEnv): string[] {
  if (!isDeployment(env)) return []
  if (env.ASCENDANT_DEMO_MODE === '1') return []
  return REQUIRED_DEPLOYMENT_ENV.filter((key) => !env[key])
}

export const OPEN_DASHBOARD_ERROR =
  'ASCENDANT_DASHBOARD_PASSWORD is not set.\n\n' +
  'The Policy view writes the autonomy threshold that gates autonomous action, so an\n' +
  'unauthenticated deploy is a privilege escalation on the whole pipeline: lower the\n' +
  'threshold and work that should have stopped for a human ships on its own.\n\n' +
  'Set it in the deployment environment, or set ASCENDANT_ALLOW_OPEN_DASHBOARD=1 to\n' +
  'deploy without auth on purpose.'
