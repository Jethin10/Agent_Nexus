import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { embeddings, events, type Db, type EventRow } from '@ascendant/db'

export const PRODUCTION_EMBEDDING_MODEL = 'gemini-embedding-001'
export const PRODUCTION_EMBEDDING_DIMENSIONS = 768
const API = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_EMBED_CHARS = 12_000

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

export type EmbeddingTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

export interface EmbedOptions {
  apiKey: string
  text: string
  task: EmbeddingTask
  title?: string
  fetcher?: typeof fetch
  model?: string
}

/** Google REST adapter kept outside agents: embedding is deterministic I/O, not judgement. */
export async function embedText(opts: EmbedOptions): Promise<number[]> {
  if (!opts.apiKey) throw new EmbeddingError('GEMINI_API_KEY is not configured')
  const model = opts.model ?? PRODUCTION_EMBEDDING_MODEL
  const response = await (opts.fetcher ?? fetch)(
    `${API}/${encodeURIComponent(model)}:embedContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': opts.apiKey,
      },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: opts.text.slice(0, MAX_EMBED_CHARS) }] },
        taskType: opts.task,
        outputDimensionality: PRODUCTION_EMBEDDING_DIMENSIONS,
        ...(opts.title ? { title: opts.title.slice(0, 300) } : {}),
      }),
    },
  )

  if (!response.ok) {
    throw new EmbeddingError(
      `Gemini embedding failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
      response.status,
    )
  }
  const body = (await response.json()) as { embedding?: { values?: unknown[] } }
  const values = body.embedding?.values
  if (!Array.isArray(values) || values.length !== PRODUCTION_EMBEDDING_DIMENSIONS) {
    throw new EmbeddingError(
      `Gemini returned ${values?.length ?? 0} dimensions; expected ${PRODUCTION_EMBEDDING_DIMENSIONS}`,
    )
  }
  const vector = values.map(Number)
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingError('Gemini returned a non-numeric embedding')
  }
  return vector
}

export function eventEmbeddingContent(event: Pick<EventRow, 'title' | 'body'>): string {
  return `${event.title}\n\n${event.body}`.slice(0, MAX_EMBED_CHARS)
}

/** Idempotent corpus write. A model change overwrites the vector instead of mixing spaces. */
export async function embedEvent(
  db: Db,
  event: EventRow,
  opts: { apiKey: string; fetcher?: typeof fetch },
): Promise<number[]> {
  const content = eventEmbeddingContent(event)
  const vec768 = await embedText({
    apiKey: opts.apiKey,
    text: content,
    title: event.title,
    task: 'RETRIEVAL_DOCUMENT',
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
  })

  await db
    .insert(embeddings)
    .values({
      orgId: event.orgId,
      entityKind: 'event',
      entityId: event.id,
      chunk: 0,
      content,
      model: PRODUCTION_EMBEDDING_MODEL,
      vec768,
    })
    .onConflictDoUpdate({
      target: [embeddings.orgId, embeddings.entityKind, embeddings.entityId, embeddings.chunk],
      set: {
        content,
        model: PRODUCTION_EMBEDDING_MODEL,
        vec768,
        vec384: null,
        createdAt: sql`now()`,
      },
    })
  return vec768
}

/** Events needing initial embedding or migration from an older embedding space. */
export async function eventsMissingProductionEmbedding(
  db: Db,
  orgId: string,
  limit = 50,
): Promise<EventRow[]> {
  return db
    .select({ event: events })
    .from(events)
    .leftJoin(
      embeddings,
      and(
        eq(embeddings.orgId, events.orgId),
        eq(embeddings.entityKind, 'event'),
        sql`${embeddings.entityId} = ${events.id}::text`,
        eq(embeddings.chunk, 0),
      ),
    )
    .where(
      and(
        eq(events.orgId, orgId),
        or(
          isNull(embeddings.id),
          isNull(embeddings.vec768),
          sql`${embeddings.model} is distinct from ${PRODUCTION_EMBEDDING_MODEL}`,
        ),
      ),
    )
    .orderBy(events.createdAt)
    .limit(Math.max(1, Math.min(limit, 200)))
    .then((rows) => rows.map((row) => row.event))
}
