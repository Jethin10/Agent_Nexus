import { integrationReadiness, type IntegrationStatus } from '@ascendant/workflows'

export const metadata = {
  title: 'Ascendant — Runtime integrations',
  description: 'Production connection status for Ascendant workflows.',
}

export const dynamic = 'force-dynamic'

const ENDPOINTS = [
  { name: 'GitHub webhook', path: '/api/webhooks/github', use: 'Issues, comments, and pull requests' },
  { name: 'Slack interactions', path: '/api/webhooks/slack', use: 'Signed human review actions' },
  { name: 'Context sync', path: '/api/context/sync', use: 'Bounded Gmail and Slack history import' },
  { name: 'Inngest functions', path: '/api/inngest', use: 'Durable workflow execution' },
]

interface Props {
  searchParams: Promise<{ sync?: string; read?: string; inserted?: string; queued?: string; reason?: string }>
}

export default async function IntegrationsPage({ searchParams }: Props) {
  const params = await searchParams
  const checks = integrationReadiness()
  const ready = checks.filter((check) => check.status === 'ready').length
  const blockers = checks.filter((check) => check.status !== 'ready')

  return (
    <div className="integrations-page">
      <header className="integrations-header">
        <div>
          <span className="eyebrow">Production runtime</span>
          <h1>Integrations</h1>
          <p>
            This surface reports the server configuration that receives real events,
            runs the decision pipeline, and publishes reviewable work. Credential values
            are never rendered.
          </p>
        </div>
        <div className={`readiness-score${blockers.length === 0 ? ' is-ready' : ''}`}>
          <strong>{ready}/{checks.length}</strong>
          <span>{blockers.length === 0 ? 'ready to run' : 'connections ready'}</span>
        </div>
      </header>

      {blockers.length > 0 && (
        <section className="readiness-banner" role="status">
          <span>{blockers.length}</span>
          <div>
            <strong>Production setup is incomplete</strong>
            <p>Finish the degraded or missing connections, then run <code>pnpm integrations:check --strict</code>.</p>
          </div>
        </section>
      )}

      {params.sync && (
        <section className={`readiness-banner sync-result sync-${params.sync}`} role="status">
          <span>{params.sync === 'ok' ? '✓' : '!'}</span>
          <div>
            <strong>{params.sync === 'ok' ? 'Context sync completed' : params.sync === 'missing' ? 'No inbound source is configured' : 'Context sync failed'}</strong>
            <p>{params.sync === 'ok'
              ? `${params.read ?? 0} read · ${params.inserted ?? 0} new · ${params.queued ?? 0} queued for analysis`
              : params.reason ?? 'Add the Gmail or Slack history variables below, then retry.'}</p>
          </div>
        </section>
      )}

      <section className="context-sync-panel">
        <div>
          <span className="eyebrow">Judge rehearsal</span>
          <h2>Sync conversation context</h2>
          <p>Imports only the configured Gmail query and Slack channel. Existing provider ids are deduplicated.</p>
        </div>
        <form action="/api/context/sync" method="post">
          <button className="primary-action" type="submit">Sync Gmail + Slack</button>
        </form>
      </section>

      <section className="integration-grid" aria-label="Integration readiness">
        {checks.map((check) => (
          <article className="integration-card" key={check.id}>
            <div className="integration-card-heading">
              <IntegrationMark name={check.name} />
              <div>
                <h2>{check.name}</h2>
                <Status status={check.status} />
              </div>
            </div>
            <p>{check.detail}</p>
            <div className="integration-requirements">
              <span>Required configuration</span>
              {check.required.map((name) => <code key={name}>{name}</code>)}
            </div>
          </article>
        ))}
      </section>

      <section className="runtime-endpoints">
        <div>
          <span className="eyebrow">Deployment contract</span>
          <h2>Signed endpoints</h2>
          <p>Point each provider at the deployed origin plus the path below.</p>
        </div>
        <div className="endpoint-list">
          {ENDPOINTS.map((endpoint) => (
            <div key={endpoint.path}>
              <span><strong>{endpoint.name}</strong><small>{endpoint.use}</small></span>
              <code>{endpoint.path}</code>
            </div>
          ))}
        </div>
      </section>

      <footer className="integration-footnote">
        <strong>Safe readiness check</strong>
        <span>The strict CLI probe reads external state but creates no issues, messages, or pull requests.</span>
        <code>pnpm integrations:check --strict</code>
      </footer>
    </div>
  )
}

function Status({ status }: { status: IntegrationStatus }) {
  return <span className={`integration-status status-${status}`}><i />{status}</span>
}

function IntegrationMark({ name }: { name: string }) {
  return <span className="integration-mark" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
}
