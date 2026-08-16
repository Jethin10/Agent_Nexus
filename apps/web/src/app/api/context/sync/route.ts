import { currentOrgId } from '@/lib/org'
import { syncConfiguredContext } from '@/lib/context-ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Operator-triggered, read-only provider sync. Middleware protects this mutation. */
export async function POST(req: Request): Promise<Response> {
  try {
    const results = await syncConfiguredContext(currentOrgId())
    const url = new URL('/integrations', req.url)
    if (results.length === 0) {
      url.searchParams.set('sync', 'missing')
    } else {
      url.searchParams.set('sync', 'ok')
      url.searchParams.set('read', String(results.reduce((sum, item) => sum + item.read, 0)))
      url.searchParams.set('inserted', String(results.reduce((sum, item) => sum + item.inserted, 0)))
      url.searchParams.set('queued', String(results.reduce((sum, item) => sum + item.dispatched, 0)))
    }
    return Response.redirect(url, 303)
  } catch (error) {
    const url = new URL('/integrations', req.url)
    url.searchParams.set('sync', 'failed')
    url.searchParams.set('reason', safeReason(error))
    return Response.redirect(url, 303)
  }
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Context sync failed'
  return message.replace(/[\r\n]/g, ' ').slice(0, 180)
}
