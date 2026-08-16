import { and, eq } from 'drizzle-orm'
import {
  db, decisionForEvent, getEvent, readPolicy, runTrace, ticketTrace, threadEvents,
  tickets, type AgentEventRow,
} from '@ascendant/db'
import { currentOrgId } from '@/lib/org'
import { ensureDb, isLocalDb } from '@/lib/local-db'
import { runsForEvent } from '@/lib/runs'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isLocalDb()) return Response.json({ error: 'local data API is disabled' }, { status: 404 })
  await ensureDb()
  const { id } = await params
  const orgId = currentOrgId()
  const database = db()
  const event = await getEvent(database, orgId, id)
  if (!event) return Response.json({ error: 'event not found' }, { status: 404 })

  const [decision, policy, conversation, ticketRows, runIds] = await Promise.all([
    decisionForEvent(database, orgId, id),
    readPolicy(database, orgId),
    threadEvents(database, orgId, event.unitKey),
    database.select().from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.eventId, id))).limit(1),
    runsForEvent(database, orgId, id),
  ])
  const ticket = ticketRows[0] ?? null
  const traces = await Promise.all([
    ...runIds.map((runId) => runTrace(database, orgId, runId)),
    ...(ticket ? [ticketTrace(database, orgId, ticket.id)] : []),
  ])
  const timeline = mergeRows(traces.flat())

  return Response.json({
    event: { ...event, raw: undefined, createdAt: event.createdAt.toISOString(), ingestedAt: event.ingestedAt.toISOString() },
    decision: decision ? { ...decision, confidence: Number(decision.confidence), createdAt: decision.createdAt.toISOString() } : null,
    bands: policy.bands,
    ticket,
    conversation: conversation.map((row) => ({ ...row, raw: undefined, createdAt: row.createdAt.toISOString(), ingestedAt: row.ingestedAt.toISOString() })),
    timeline: timeline.map((row) => ({ ...row, at: row.at.toISOString() })),
  })
}

function mergeRows(rows: AgentEventRow[]): AgentEventRow[] {
  const unique = new Map(rows.map((row) => [row.id, row]))
  return [...unique.values()].sort((a, b) => a.at.getTime() - b.at.getTime())
}
