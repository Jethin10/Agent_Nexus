import { db, inbox } from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb, isLocalDb } from '@/lib/local-db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  if (!isLocalDb()) return Response.json({ error: 'local data API is disabled' }, { status: 404 })
  await ensureDb()
  const url = new URL(req.url)
  const rows = await inbox(db(), currentOrgId(), {
    limit: 100,
    order: url.searchParams.get('order') === 'oldest' ? 'oldest' : 'newest',
    ...(url.searchParams.get('q') ? { query: url.searchParams.get('q') as string } : {}),
  })
  return Response.json({
    rows: rows.map((row) => ({
      ...row,
      confidence: row.confidence === null ? null : Number(row.confidence),
      createdAt: row.createdAt.toISOString(),
    })),
  })
}
