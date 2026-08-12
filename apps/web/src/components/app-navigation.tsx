'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

const ITEMS = [
  { href: '/', label: 'Inbox', icon: InboxIcon, match: '/' },
  { href: '/metrics', label: 'Decisions', icon: LayersIcon, match: '/metrics' },
  { href: '/?review=1', label: 'Evidence', icon: DocumentIcon, match: '/evidence' },
  { href: '/policy', label: 'Policy', icon: ShieldIcon, match: '/policy' },
  { href: '/integrations', label: 'Integrations', icon: PlugIcon, match: '/integrations' },
]

export function AppNavigation() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isEvidence = pathname === '/' && searchParams.get('review') === '1'

  return (
    <nav className="nav" aria-label="Primary navigation">
      {ITEMS.map((item) => {
        const active = item.label === 'Evidence' ? isEvidence : pathname === item.match && !isEvidence
        const Icon = item.icon
        return (
          <Link key={item.label} href={item.href} className={active ? 'active' : undefined}>
            <Icon />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

function PlugIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 0 1-5 5v3M7 17h6" /></svg>
}

function InboxIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v11H3zM3 11h4l1.5 2h3l1.5-2h4" /></svg>
}
function LayersIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2.8 7 3.7-7 3.7-7-3.7 7-3.7ZM3 10l7 3.7 7-3.7M3 13.5l7 3.7 7-3.7" /></svg>
}
function DocumentIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></svg>
}
function ShieldIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.5c0 3.6-2.3 6.3-6 8-3.7-1.7-6-4.4-6-8V5l6-2.5ZM7.3 10l1.8 1.8 3.8-4" /></svg>
}
