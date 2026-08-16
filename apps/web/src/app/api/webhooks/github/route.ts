import { normalize } from '@ascendant/core'
import { githubConnector, isGithubRepositoryRef } from '@ascendant/connectors'
import { db, insertEvent, readPolicy } from '@ascendant/db'
import { scanForInjection } from '@ascendant/router'
import { inngest } from '@ascendant/workflows'
import { currentOrgId } from '@/lib/org'
import { ensureDb } from '@/lib/local-db'

/**
 * The GitHub webhook receiver. §13.3: on Vercel Hobby a function is capped at 60s, so
 * this handler's only job is **verify → insert → emit → 200**. All real work is deferred
 * to Inngest.
 *
 * §15.2, the rule that must never be relaxed: signature verification needs the **raw**
 * body, so this reads `await req.text()` and parses only after verifying. Calling
 * `req.json()` first would re-serialize the bytes and every HMAC would fail — and the
 * tempting "fix" for that is to stop verifying.
 */
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    // Refusing is the safe default: accepting unauthenticated payloads would let anyone
    // inject events into the triage pipeline.
    return json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' }, 503)
  }

  // Raw bytes first, before anything parses them.
  const body = await req.text()
  const connector = githubConnector({ secret })

  const authentic = await connector.verify({ headers: req.headers, body })
  if (!authentic) {
    return json({ error: 'signature verification failed' }, 401)
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return json({ error: 'body is not JSON' }, 400)
  }

  const orgId = currentOrgId()
  await ensureDb()
  const deliveryId = req.headers.get('x-github-delivery') ?? undefined

  let raws
  try {
    raws = await connector.parse(payload, { orgId, ...(deliveryId ? { deliveryId } : {}) })
  } catch (err) {
    // A payload shape we do not read is not an error worth retrying: GitHub payloads are
    // enormous and their unread parts change without notice (D4).
    return json({ error: err instanceof Error ? err.message : 'parse failed' }, 422)
  }

  // Actions that produce no unit of work — a label change, a milestone — return [].
  if (raws.length === 0) {
    return json({ ok: true, ignored: true, action: readAction(payload) }, 200)
  }

  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  if (!owner || !repo) {
    return json({ error: 'GITHUB_OWNER and GITHUB_REPO are not configured' }, 503)
  }
  if (raws.some((raw) => !isGithubRepositoryRef(raw.sourceRef, { owner, repo }))) {
    // One App webhook secret can authenticate payloads from every installation. A
    // valid signature therefore proves GitHub sent the event, not that this deployment
    // is authorized to turn that repository's issue into work against its configured repo.
    return json({ error: 'repository is not authorized for this deployment' }, 403)
  }

  const database = db()
  const policy = await readPolicy(database, orgId)
  const accepted: { eventId: string; sourceRef: string; inserted: boolean }[] = []

  for (const raw of raws) {
    /**
     * §15.3 layer 1. A positive detection does not block the event: it sets
     * `injectionSuspected`, which caps confidence at 0.5 and therefore forces ESCALATE.
     * A human sees it and the agent never acts on it. Blocking would hand an attacker a
     * denial-of-service, and a legitimate bug report quoting a hostile-looking error
     * string is exactly what a human should judge rather than a filter should eat.
     */
    const guard = await scanForInjection(
      `${raw.title}\n\n${raw.body}`,
      `${raw.source}:${raw.kind}:${raw.sourceRef}`,
      { env: { GROQ_API_KEY: process.env.GROQ_API_KEY } },
    )

    const event = normalize(raw, {
      internalActors: policy.internalActors,
      knownExternalActors: policy.knownExternalActors,
      injectionSuspected: guard.suspected,
    })

    const { row, inserted } = await insertEvent(database, event)
    accepted.push({ eventId: row.id, sourceRef: row.sourceRef, inserted })

    /**
     * Send on every delivery, including a retry whose row already exists. The stable
     * event id gives Inngest an idempotency key: if the first send succeeded it is
     * deduplicated, while a failed first send can be repaired by GitHub's redelivery.
     * Skipping `inserted === false` would strand a persisted event forever when the DB
     * write succeeded but the first Inngest request failed.
     */
    await inngest.send({
      id: `ascendant:event:${row.id}`,
      name: 'event/received',
      data: { orgId, eventId: row.id, source: row.source, sourceRef: row.sourceRef },
    })
  }

  return json({ ok: true, events: accepted }, 202)
}

function readAction(payload: unknown): string | undefined {
  return typeof payload === 'object' && payload !== null && 'action' in payload
    ? String((payload as { action?: unknown }).action)
    : undefined
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
