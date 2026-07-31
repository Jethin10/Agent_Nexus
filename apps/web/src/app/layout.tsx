import type { Metadata } from 'next'
import Link from 'next/link'
import { demoMode } from '@/lib/org'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ascendant',
  description: 'Decides what to build. Then builds it.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const mode = demoMode()

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">Ascendant</div>
            <p className="tagline">Decides what to build. Then builds it.</p>
            <nav className="nav">
              <Link href="/">Inbox</Link>
              <Link href="/metrics">Metrics</Link>
              <Link href="/policy">Policy</Link>
            </nav>
            {mode === 'replay' && (
              <p className="small dim" style={{ marginTop: 22 }}>
                <span className="pill flag">replay</span>
                <br />
                Serving recorded runs at their original timing.
              </p>
            )}
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  )
}
