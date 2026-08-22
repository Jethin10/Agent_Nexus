'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

const MAIN_ITEMS = [
  { href: '/', label: 'Inbox', icon: InboxIcon, match: '/' },
  { href: '/ledger', label: 'Requests', icon: InboxIcon, match: '/ledger' },
  { href: '/metrics', label: 'Agents', icon: RunsIcon, match: '/metrics' },
  { href: '/?review=1', label: 'Approvals', icon: ApprovalIcon, match: '/approvals' },
  { href: '/ledger', label: 'Evidence', icon: DocumentIcon, match: '/evidence' },
  { href: '/integrations', label: 'Repositories', icon: RepositoryIcon, match: '/integrations' },
  { href: '/policy', label: 'Settings', icon: ShieldIcon, match: '/policy' },
]

export function AppNavigation() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const needsReview = pathname === '/' && searchParams.get('review') === '1'

  return (
    <nav className="nav" aria-label="Primary navigation">
      {MAIN_ITEMS.map((item) => {
        const active = item.label === 'Approvals' ? needsReview : pathname === item.match && !needsReview
        const Icon = item.icon
        return <Link key={item.label} href={item.href} className={active ? 'active' : undefined}><Icon /><span>{item.label}</span></Link>
      })}
    </nav>
  )
}

function InboxIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v11H3zM3 11h4l1.5 2h3l1.5-2h4" /></svg> }
function RunsIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h8M4 15h10" /><circle cx="15" cy="10" r="2" /></svg> }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg> }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 3.6-2.3 6.3-6 8-3.7-1.7-6-4.4-6-8V5l6-2.5ZM7.3 10l1.8 1.8 3.8-4" /></svg> }
function ApprovalIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4" /></svg> }
function RepositoryIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h5l1.5 2H17v8.5H3z" /><path d="M3 8h14" /></svg> }
