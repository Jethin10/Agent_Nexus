import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { currentOrgId } from '@/lib/org'
import { AppNavigation } from '@/components/app-navigation'
import './globals.css'
import './premium.css'

export const metadata: Metadata = {
  title: 'Ascendant — Agent command center',
  description: 'Route product signals into governed, observable agent runs.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const workspace =
    process.env.ASCENDANT_WORKSPACE_NAME ??
    (process.env.GITHUB_OWNER && process.env.GITHUB_REPO
      ? `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`
      : currentOrgId())
  const runtime = process.env.DATABASE_URL ? 'Server runtime' : 'Local development'

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand-lockup">
              <span className="brand-mark" aria-hidden="true"><AscendantMark /></span>
              <span className="brand">Ascendant</span>
            </div>
            <Suspense fallback={<div className="nav nav-loading" aria-hidden="true" />}>
              <AppNavigation />
            </Suspense>
            <div className="sidebar-footer">
              <Link className="connection-health" href="/integrations"><i /><span>All systems operational</span></Link>
              <div className="workspace-identity"><div className="workspace-avatar">A</div><div><strong>{workspace}</strong><span>{runtime}</span></div></div>
            </div>
          </aside>
          <div className="app-frame">
            <header className="global-toolbar">
              <div className="toolbar-product"><strong>Agent Command Center</strong><span>Workspace</span></div>
              <form action="/" className="global-search">
                <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.2" /><path d="m12.3 12.3 4.2 4.2" /></svg>
                <input name="q" aria-label="Search runs, tickets, and repositories" placeholder="Search runs, tickets, repos, users…" />
                <span>⌘K</span>
              </form>
              <nav className="toolbar-actions" aria-label="Account shortcuts">
                <Link className="running-indicator" href="/?review=running"><i /><span>3 running</span></Link>
                <Link className="new-request" href="/integrations"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg><span>New request</span></Link>
                <Link className="toolbar-utility" href="/integrations" aria-label="Integration settings"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" /></svg></Link>
              </nav>
            </header>
            <main className="main">{children}</main>
          </div>
        </div>
      </body>
    </html>
  )
}

function AscendantMark() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 18.8 7v7.8L12 20.8l-6.8-6V7L12 3.2Z" /><path d="m8.3 13.8 3.7-6.1 3.7 6.1M9.8 11.5h4.4" /></svg>
}
