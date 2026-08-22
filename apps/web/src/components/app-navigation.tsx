'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

const MAIN_ITEMS = [
  { href: '/', label: 'Inbox', icon: InboxIcon, match: '/' },
  { href: '/metrics', label: 'Runs', icon: RunsIcon, match: '/metrics' },
  { href: '/ledger', label: 'Ledger', icon: DocumentIcon, match: '/ledger' },
  { href: '/policy', label: 'Policy', icon: ShieldIcon, match: '/policy' },
  { href: '/integrations', label: 'Integrations', icon: PlugIcon, match: '/integrations' },
]

export function AppNavigation() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const needsReview = pathname === '/' && searchParams.get('review') === '1'

  return (
    <nav className="nav" aria-label="Primary navigation">
      <span className="nav-section-label">Main</span>
      {MAIN_ITEMS.map((item) => {
        const active = pathname === item.match && !needsReview
        const Icon = item.icon
        return <Link key={item.label} href={item.href} className={active ? 'active' : undefined}><Icon /><span>{item.label}</span></Link>
      })}
      <span className="nav-section-label nav-section-spaced">Workspace</span>
      <Link href="/?review=1" className={needsReview ? 'active' : undefined}><ApprovalIcon /><span>Approvals</span></Link>
      <Link href="/integrations"><GridIcon /><span>All connections</span></Link>
    </nav>
  )
}

function PlugIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 0 1-5 5v3M7 17h6" /></svg> }
function InboxIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v11H3zM3 11h4l1.5 2h3l1.5-2h4" /></svg> }
function RunsIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h8M4 15h10" /><circle cx="15" cy="10" r="2" /></svg> }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg> }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 3.6-2.3 6.3-6 8-3.7-1.7-6-4.4-6-8V5l6-2.5ZM7.3 10l1.8 1.8 3.8-4" /></svg> }
function ApprovalIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4" /></svg> }
function GridIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="5" height="5" rx="1" /><rect x="12" y="3" width="5" height="5" rx="1" /><rect x="3" y="12" width="5" height="5" rx="1" /><rect x="12" y="12" width="5" height="5" rx="1" /></svg> }
