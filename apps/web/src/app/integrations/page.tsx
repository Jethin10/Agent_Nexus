import Link from 'next/link'
import { connectionForOrg, connectionSummaries, githubInstallationToken, integrationReadiness, listInstallationRepositories, type ConnectionProvider, type ConnectionSummary } from '@ascendant/workflows'
import { db } from '@ascendant/db'
import { ensureDb, isLocalDb } from '@/lib/local-db'
import { currentOrgId } from '@/lib/org'
import { disconnectConnection, selectGithubRepository } from './actions'

export const metadata = { title: 'Ascendant — Connections', description: 'Connect the accounts Ascendant can read and act on.' }
export const dynamic = 'force-dynamic'

interface Props { searchParams: Promise<{ connected?: string; reason?: string; sync?: string; read?: string; inserted?: string; queued?: string }> }
const PROVIDERS: Array<{ id: ConnectionProvider; name: string; description: string; connectHref: string; action: string }> = [
  { id: 'github', name: 'GitHub', description: 'Install the Ascendant App, then choose the repository it can work in.', connectHref: '/api/connect/github', action: 'Install GitHub App' },
  { id: 'slack', name: 'Slack', description: 'Send progress and approvals to the channel chosen during installation.', connectHref: '/api/connect/slack', action: 'Connect Slack' },
  { id: 'gmail', name: 'Gmail', description: 'Read only the bounded Gmail context query. Ascendant cannot send or modify mail.', connectHref: '/api/connect/google', action: 'Connect Gmail' },
]

export default async function IntegrationsPage({ searchParams }: Props) {
  const params = await searchParams
  const { summaries, githubRepositories, loadError } = await loadConnections()
  const byProvider = new Map(summaries.map((summary) => [summary.provider, summary]))
  const runtime = integrationReadiness()
  const runtimeReady = runtime.filter((item) => item.status === 'ready').length
  return (
    <main className="connections-page">
      <header className="connections-hero">
        <div className="connections-hero-copy"><span className="eyebrow">Workspace access</span><h1>Connect your operating surface</h1><p>Authorize each account once. Ascendant stores grants encrypted, requests narrow scopes, and keeps consequential actions behind review.</p></div>
        <div className="connections-progress" aria-label={`${summaries.length} of ${PROVIDERS.length} accounts connected`}><strong>{summaries.length}/{PROVIDERS.length}</strong><span>accounts connected</span><div><i style={{ width: `${(summaries.length / PROVIDERS.length) * 100}%` }} /></div></div>
      </header>

      {(params.connected || params.reason || loadError) && <Notice success={Boolean(params.connected)} title={params.connected ? `${providerLabel(params.connected)} connected` : 'Connection needs attention'} detail={params.connected ? 'The encrypted grant is ready for this workspace.' : params.reason ?? loadError ?? 'Try the connection again.'} />}

      <section className="connection-list" aria-label="Account connections">
        {PROVIDERS.map((provider) => {
          const summary = byProvider.get(provider.id)
          return <article className={`connection-row ${summary ? 'is-connected' : ''}`} key={provider.id}>
            <div className={`connection-provider-mark provider-${provider.id}`} aria-hidden="true">{provider.name[0]}</div>
            <div className="connection-provider-copy">
              <div className="connection-provider-title"><h2>{provider.name}</h2><span className={`connection-state ${summary ? 'is-connected' : ''}`}><i />{summary ? 'Connected' : 'Not connected'}</span></div>
              <p>{provider.description}</p>{summary && <ConnectionIdentity summary={summary} />}
              {summary?.provider === 'github' && githubRepositories.length > 0 && <form className="repository-selector" action={selectGithubRepository}><label htmlFor="repository">Active repository</label><select id="repository" name="repository" defaultValue={summary.owner && summary.repo ? `${summary.owner}/${summary.repo}` : ''}>{!summary.repo && <option value="" disabled>Choose a repository</option>}{githubRepositories.map((repository) => <option key={repository.fullName}>{repository.fullName}</option>)}</select><button type="submit">Use repository</button></form>}
            </div>
            <div className="connection-actions">{summary ? <><Link className="connection-button secondary" href={provider.connectHref}>Reconnect</Link><form action={disconnectConnection}><input type="hidden" name="provider" value={provider.id} /><button className="connection-button quiet" type="submit">Disconnect</button></form></> : <Link className="connection-button primary" href={provider.connectHref}>{provider.action}</Link>}</div>
          </article>
        })}
      </section>

      {params.sync && <Notice success={params.sync === 'ok'} title={params.sync === 'ok' ? 'Context sync completed' : 'Context sync did not run'} detail={params.sync === 'ok' ? `${params.read ?? 0} read · ${params.inserted ?? 0} new · ${params.queued ?? 0} queued` : params.reason ?? 'Connect Gmail or Slack first.'} />}
      <section className="connection-operations"><div><span className="eyebrow">Live context</span><h2>Pull the latest conversations</h2><p>Import the bounded Gmail query and selected Slack channel, deduplicate provider IDs, then send new context through the real workflow.</p></div><form action="/api/context/sync" method="post"><button className="connection-button primary" type="submit">Sync connected accounts</button></form></section>
      <section className="runtime-readiness"><div className="runtime-readiness-heading"><div><span className="eyebrow">Production infrastructure</span><h2>{runtimeReady}/{runtime.length} runtime checks ready</h2></div><code>pnpm integrations:check --strict</code></div><div className="runtime-checks">{runtime.map((item) => <div key={item.id}><span className={`runtime-dot status-${item.status}`} /><strong>{item.name}</strong><small>{item.detail}</small></div>)}</div></section>
    </main>
  )
}

async function loadConnections(): Promise<{ summaries: ConnectionSummary[]; githubRepositories: Array<{ fullName: string }>; loadError?: string }> {
  try {
    // The offline demo intentionally has no reusable OAuth grants. Avoid booting the
    // PGlite WASM store on this server-rendered page until encryption is configured;
    // the connection cards still provide the complete setup flow and readiness view.
    if (isLocalDb() && !process.env.ASCENDANT_CONNECTIONS_KEY) {
      return { summaries: [], githubRepositories: [] }
    }
    await ensureDb(); const database = db(); const orgId = currentOrgId()
    const summaries = await connectionSummaries(database, orgId)
    const github = await connectionForOrg(database, orgId, 'github')
    if (!github) return { summaries, githubRepositories: [] }
    try {
      const token = await githubInstallationToken({ appId: requireEnv('GITHUB_APP_ID'), privateKeyBase64: requireEnv('GITHUB_APP_PRIVATE_KEY_BASE64'), installationId: github.installationId })
      const repositories = await listInstallationRepositories({ token })
      return { summaries, githubRepositories: repositories.map(({ fullName }) => ({ fullName })) }
    } catch (error) {
      return { summaries, githubRepositories: [], loadError: safeError(error) }
    }
  } catch (error) {
    return { summaries: [], githubRepositories: [], loadError: safeError(error) }
  }
}

function ConnectionIdentity({ summary }: { summary: ConnectionSummary }) {
  if (summary.provider === 'github') return <div className="connection-identity"><code>{summary.owner && summary.repo ? `${summary.owner}/${summary.repo}` : 'Repository selection required'}</code><span>{summary.repo ? `default branch ${summary.defaultBranch ?? 'auto'}` : 'Choose one installed repository before agents can run'}</span></div>
  if (summary.provider === 'slack') return <div className="connection-identity"><code>{summary.teamName ?? summary.teamId}</code><span>channel {summary.channelId}</span></div>
  return <div className="connection-identity"><code>{summary.email}</code><span>read-only mail access</span></div>
}
function Notice({ success, title, detail }: { success: boolean; title: string; detail: string }) { return <section className={`connection-notice ${success ? 'is-success' : 'is-error'}`} role="status"><span>{success ? '✓' : '!'}</span><div><strong>{title}</strong><p>{detail}</p></div></section> }
function providerLabel(value: string): string { return value === 'gmail' || value === 'google' ? 'Gmail' : value === 'github' ? 'GitHub' : value === 'slack' ? 'Slack' : 'Account' }
function requireEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured`); return value }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : 'Connections could not be loaded').replace(/[\r\n]/g, ' ').slice(0, 180) }
