import { describe, expect, it } from 'vitest'
import { integrationReadiness, type IntegrationReadiness } from './readiness.js'

const byId = (env: Record<string, string | undefined>) =>
  Object.fromEntries(integrationReadiness(env).map((item) => [item.id, item])) as Record<
    IntegrationReadiness['id'],
    IntegrationReadiness
  >

describe('integrationReadiness', () => {
  it('marks a complete production configuration ready without returning secrets', () => {
    const checks = byId({
      GITHUB_OWNER: 'acme',
      GITHUB_REPO: 'api',
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_BASE64: 'private-secret',
      GITHUB_WEBHOOK_SECRET: 'webhook-secret',
      DATABASE_URL: 'postgres://secret',
      INNGEST_EVENT_KEY: 'event-secret',
      INNGEST_SIGNING_KEY: 'signing-secret',
      GROQ_API_KEY: 'model-secret',
      SLACK_BOT_TOKEN: 'slack-secret',
      SLACK_CHANNEL_ID: 'C123',
      SLACK_SIGNING_SECRET: 'slack-signing-secret',
      LINEAR_API_KEY: 'linear-secret',
      LINEAR_TEAM_ID: 'team-id',
      E2B_API_KEY: 'e2b-secret',
      ASCENDANT_DASHBOARD_PASSWORD: 'dashboard-secret',
    })

    expect(Object.values(checks).every((check) => check.status === 'ready')).toBe(true)
    const rendered = JSON.stringify(checks)
    for (const secret of [
      'private-secret',
      'webhook-secret',
      'postgres://secret',
      'model-secret',
      'slack-secret',
      'linear-secret',
      'e2b-secret',
      'dashboard-secret',
    ]) {
      expect(rendered).not.toContain(secret)
    }
  })

  it('flags incomplete GitHub App credentials instead of falling back silently', () => {
    const checks = byId({
      GITHUB_OWNER: 'acme',
      GITHUB_REPO: 'api',
      GITHUB_APP_ID: '123',
      GITHUB_TOKEN: 'fallback-token',
      GITHUB_WEBHOOK_SECRET: 'secret',
    })

    expect(checks.github).toMatchObject({ status: 'degraded' })
    expect(checks.github.detail).toContain('incomplete')
  })

  it('reports an unapproved static GitHub token as degraded', () => {
    const checks = byId({
      GITHUB_OWNER: 'acme',
      GITHUB_REPO: 'api',
      GITHUB_TOKEN: 'static-token',
      GITHUB_WEBHOOK_SECRET: 'secret',
    })

    expect(checks.github.status).toBe('degraded')
    expect(checks.github.detail).toContain('disabled')
    expect(JSON.stringify(checks.github)).not.toContain('static-token')
  })

  it('labels local-only database and sandbox drivers as degraded', () => {
    const checks = byId({
      ASCENDANT_LOCAL_DB: '1',
      ASCENDANT_ALLOW_LOCAL_SANDBOX: '1',
    })

    expect(checks.database.status).toBe('degraded')
    expect(checks.sandbox.status).toBe('degraded')
  })

  it('requires both inbound and outbound credentials for signed integrations', () => {
    const checks = byId({
      INNGEST_EVENT_KEY: 'event',
      SLACK_BOT_TOKEN: 'bot',
      SLACK_CHANNEL_ID: 'C123',
    })

    expect(checks.inngest.status).toBe('degraded')
    expect(checks.slack.status).toBe('degraded')
  })
})
