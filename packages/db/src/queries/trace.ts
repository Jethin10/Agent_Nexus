import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { agentEvents, type AgentEventRow } from '../schema/agent-events'
import { artifacts, type ArtifactRow } from '../schema/artifacts'
import { runs, type RunRow } from '../schema/runs'

/**
 * The project's own observability spine. Inngest Free retains traces for 24 hours
 * and Vercel Hobby logs for 1 hour, so if a run happened on Friday and the demo is
 * on Sunday, the vendor's dashboard is empty. Everything the Run Detail view needs
 * is written here instead — permanent, and it means the judges see this project's
 * UI rather than a vendor's.
 */

/** Never put a blob in `detail` — blobs go to `artifacts` and are referenced by id. */
const MAX_DETAIL_BYTES = 8 * 1024

function boundedDetail(detail?: Record<string, unknown>): Record<string, unknown> | null {
  if (!detail) return null
  const json = JSON.stringify(detail)
  if (json !== undefined && json.length <= MAX_DETAIL_BYTES) return detail
  return {
    _oversized: true,
    _bytes: json?.length ?? 0,
    _hint: 'store this in artifacts and reference it by id',
  }
}

export interface TraceInput {
  orgId: string
  ticketId?: string | undefined
  runId?: string | undefined
  agent: string
  phase: string
  round?: number | undefined
  summary: string
  detail?: Record<string, unknown> | undefined
  model?: string | undefined
  tokens?: number
  latencyMs?: number
}

/**
 * One line in the timeline. Called after every agent turn, every policy decision,
 * and every cascade hop — this is the trace, so a gap here is a gap in the story
 * the Run Detail view can tell.
 */
export async function trace(db: Db, t: TraceInput): Promise<AgentEventRow> {
  const rows = await db
    .insert(agentEvents)
    .values({
      orgId: t.orgId,
      ticketId: t.ticketId ?? null,
      runId: t.runId ?? null,
      agent: t.agent,
      phase: t.phase,
      round: t.round ?? null,
      summary: t.summary.slice(0, 2000),
      detail: boundedDetail(t.detail),
      model: t.model ?? null,
      tokens: t.tokens ?? 0,
      latencyMs: t.latencyMs ?? 0,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('trace: no row returned')
  return row
}

/** The Run Detail timeline for a ticket, oldest first — the "agents arguing" view. */
export async function ticketTrace(db: Db, orgId: string, ticketId: string): Promise<AgentEventRow[]> {
  return db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.ticketId, ticketId)))
    .orderBy(asc(agentEvents.at))
    .limit(500)
}

/** Trace for one Inngest run, for a triage that never produced a ticket. */
export async function runTrace(db: Db, orgId: string, runId: string): Promise<AgentEventRow[]> {
  return db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.orgId, orgId), eq(agentEvents.runId, runId)))
    .orderBy(asc(agentEvents.at))
    .limit(500)
}

export interface SaveArtifactInput {
  orgId: string
  ticketId?: string | undefined
  runId?: string | undefined
  kind: ArtifactRow['kind']
  round?: number | undefined
  agent?: string | undefined
  content: string
  meta?: Record<string, unknown> | undefined
}

/**
 * Where every blob goes. Inngest caps event payloads at 256 KiB and step returns at
 * 4 MB, so a diff or a debate transcript is written here and the workflow passes
 * only the returned id. This is the rule that keeps a large real ticket behaving
 * like a small seeded one.
 */
export async function saveArtifact(db: Db, a: SaveArtifactInput): Promise<ArtifactRow> {
  const rows = await db
    .insert(artifacts)
    .values({
      orgId: a.orgId,
      ticketId: a.ticketId ?? null,
      runId: a.runId ?? null,
      kind: a.kind,
      round: a.round ?? null,
      agent: a.agent ?? null,
      content: a.content,
      bytes: Buffer.byteLength(a.content, 'utf8'),
      meta: a.meta ?? null,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('saveArtifact: no row returned')
  return row
}

export async function getArtifact(
  db: Db,
  orgId: string,
  id: string,
): Promise<ArtifactRow | undefined> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, id)))
    .limit(1)
  return rows[0]
}

/** Latest artifact of a kind for a ticket — e.g. the diff the QA agent should run. */
export async function latestArtifact(
  db: Db,
  orgId: string,
  ticketId: string,
  kind: ArtifactRow['kind'],
): Promise<ArtifactRow | undefined> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, orgId),
        eq(artifacts.ticketId, ticketId),
        eq(artifacts.kind, kind),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(1)
  return rows[0]
}

export async function startRun(
  db: Db,
  input: {
    orgId: string
    fn: string
    ticketId?: string | undefined
    inngestRunId?: string | undefined
    attempt?: number
    meta?: Record<string, unknown> | undefined
  },
): Promise<RunRow> {
  const rows = await db
    .insert(runs)
    .values({
      orgId: input.orgId,
      fn: input.fn,
      ticketId: input.ticketId ?? null,
      inngestRunId: input.inngestRunId ?? null,
      attempt: input.attempt ?? 0,
      meta: input.meta ?? null,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('startRun: no row returned')
  return row
}

export async function finishRun(
  db: Db,
  orgId: string,
  runId: string,
  status: RunRow['status'],
  extra: { error?: string; tokensUsed?: number; llmCalls?: number } = {},
): Promise<void> {
  await db
    .update(runs)
    .set({
      status,
      finishedAt: new Date(),
      error: extra.error ?? null,
      ...(extra.tokensUsed !== undefined ? { tokensUsed: extra.tokensUsed } : {}),
      ...(extra.llmCalls !== undefined ? { llmCalls: extra.llmCalls } : {}),
    })
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
}

/**
 * Token and call spend for the day, for the §10.4 org ceiling. Read before the
 * cascade picks a rung: a runaway loop at 2am must not be able to leave the demo
 * without quota at 10am.
 */
export async function spendToday(db: Db, orgId: string) {
  const rows = await db
    .select({
      tokens: sql<number>`coalesce(sum(${agentEvents.tokens}), 0)::int`,
      calls: sql<number>`count(*) filter (where ${agentEvents.model} is not null)::int`,
    })
    .from(agentEvents)
    .where(and(eq(agentEvents.orgId, orgId), sql`${agentEvents.at} >= current_date`))
  return rows[0] ?? { tokens: 0, calls: 0 }
}
