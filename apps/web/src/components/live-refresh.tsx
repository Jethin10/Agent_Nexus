'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

/** Keeps judge-facing server views current while provider workflows run. */
export function LiveRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter()
  const [updated, setUpdated] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => {
      router.refresh()
      setUpdated(Date.now())
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs, router])

  return (
    <span className="live-refresh" title={`Last refreshed ${new Date(updated).toLocaleTimeString()}`}>
      <i /> Live
    </span>
  )
}
