import { db, inbox } from '@ascendant/db'
import { CommandCenterDashboard, type CommandCenterRow } from '@/components/command-center-dashboard'
import { currentOrgId } from '@/lib/org'
import { ensureDb, isLocalDb } from '@/lib/local-db'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ selected?: string; q?: string; review?: string }>
}

export default async function InboxPage({ searchParams }: Props) {
  const { selected, q, review } = await searchParams

  if (isLocalDb()) {
    return <CommandCenterDashboard initialRows={[]} selectedId={selected} initialQuery={q} initialTab={review === '1' ? 'approval' : 'all'} liveLocal />
  }

  let rows: CommandCenterRow[] = []
  let error: string | undefined

  try {
    await ensureDb()
    const result = await inbox(db(), currentOrgId(), { limit: 100, order: 'newest' })
    rows = result.map((row) => ({
      ...row,
      confidence: row.confidence === null ? null : Number(row.confidence),
      createdAt: row.createdAt.toISOString(),
    }))
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  return <CommandCenterDashboard initialRows={rows} selectedId={selected} initialQuery={q} initialTab={review === '1' ? 'approval' : 'all'} error={error} />
}
