import type { Metadata } from 'next'
import { Suspense } from 'react'
import { currentOrgId } from '@/lib/org'
import { AppNavigation } from '@/components/app-navigation'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ascendant — Triage inbox',
  description: 'Decide what to build. Then build it.',
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
              <span className="brand-mark" aria-hidden="true">A</span>
              <span className="brand">Ascendant</span>
            </div>
            <Suspense fallback={<div className="nav nav-loading" aria-hidden="true" />}>
              <AppNavigation />
            </Suspense>
            <div className="sidebar-footer">
              <span className="shortcut-hint">⌘ K</span>
              <div className="workspace-avatar">A</div>
              <div>
                <strong>{workspace}</strong>
                <span>{runtime}</span>
              </div>
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  )
}
