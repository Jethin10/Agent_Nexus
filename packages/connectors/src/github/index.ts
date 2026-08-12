import type { EventKind, RawEvent } from '@ascendant/core'
import type { Connector, ParseContext, VerifiableRequest } from '../types.js'
import { WebhookError } from '../types.js'
import { hmacHex, safeEqualHex } from '../verify.js'
import {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  isBot,
  type IssuesEvent as IssuesEventT,
  type IssueCommentEvent as IssueCommentEventT,
  type PullRequestEvent as PullRequestEventT,
} from './payload.js'

/**
 * Actions worth a triage run. `edited` is included for issues because an author
 * filling in a template turns a DEFER into a decidable event; the contentHash
 * idempotency check (§7.3) makes a cosmetic edit a no-op anyway.
 */
const ISSUE_ACTIONS = new Set(['opened', 'reopened', 'edited'])
const PR_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'closed'])
const COMMENT_ACTIONS = new Set(['created'])

/** A signed App webhook may cover many installations; only the configured repo is trusted. */
export function isGithubRepositoryRef(
  sourceRef: string,
  expected: { owner: string; repo: string },
): boolean {
  const match = /^([^/#!:]+)\/([^#!:]+)[#!]\d+(?::|$)/.exec(sourceRef)
  if (!match) return false
  return `${match[1]}/${match[2]}`.toLowerCase() === `${expected.owner}/${expected.repo}`.toLowerCase()
}

/** `owner/repo#412` — also the thread key, so a comment collapses onto its issue. */
function threadRef(repo: string, number: number, isPull: boolean): string {
  return `${repo}${isPull ? '!' : '#'}${number}`
}

export interface GithubConnectorOptions {
  /** Webhook secret from the GitHub App config. Never a literal in the repo. */
  secret: string
}

export function githubConnector(opts: GithubConnectorOptions): Connector {
  return {
    id: 'github',

    /**
     * HMAC-SHA256 of the raw body against X-Hub-Signature-256, timing-safe.
     * The caller must pass `await req.text()`, not a re-serialized object: JSON
     * round-tripping changes bytes and every signature would fail (§15.2).
     */
    async verify(req: VerifiableRequest): Promise<boolean> {
      if (!opts.secret) throw new WebhookError('github webhook secret is not configured', 500)
      const header = req.headers.get('x-hub-signature-256')
      if (!header) return false
      const [algo, sig] = header.split('=', 2)
      if (algo !== 'sha256' || !sig) return false
      return safeEqualHex(sig, hmacHex('sha256', opts.secret, req.body))
    },

    async parse(raw: unknown, ctx: ParseContext): Promise<RawEvent[]> {
      if (typeof raw !== 'object' || raw === null) {
        throw new WebhookError('github payload is not an object')
      }
      const body = raw as Record<string, unknown>

      // The webhook event name is a header, not a body field, so infer from shape.
      if ('comment' in body && 'issue' in body) {
        const p = IssueCommentEvent.parse(body)
        return COMMENT_ACTIONS.has(p.action) ? [comment(p, ctx)] : []
      }
      if ('pull_request' in body) {
        const p = PullRequestEvent.parse(body)
        if (!PR_ACTIONS.has(p.action)) return []
        // Closed-but-unmerged PRs are not evidence that work already shipped.
        if (p.action === 'closed' && !p.pull_request.merged && !p.pull_request.merged_at) return []
        return [pull(p, ctx)]
      }
      if ('issue' in body) {
        const p = IssuesEvent.parse(body)
        // issues webhooks never fire for PRs, but the field exists — be explicit.
        if (p.issue.pull_request) return []
        return ISSUE_ACTIONS.has(p.action) ? [issue(p, ctx)] : []
      }
      // ping, installation, star, and everything else this system does not act on.
      return []
    },
  }
}

function actor(u: { id: number; login: string; type?: string | undefined } | null | undefined) {
  return {
    id: String(u?.id ?? 0),
    handle: u?.login ?? 'unknown',
    isBot: isBot(u),
  }
}

function base(kind: EventKind, ctx: ParseContext) {
  return { orgId: ctx.orgId, source: 'github' as const, kind, attachments: [] }
}

function issue(p: IssuesEventT, ctx: ParseContext): RawEvent {
  const ref = threadRef(p.repository.full_name, p.issue.number, false)
  return {
    ...base('issue', ctx),
    sourceRef: ref,
    threadKey: ref,
    actor: actor(p.issue.user),
    title: p.issue.title,
    body: p.issue.body ?? '',
    createdAt: new Date(p.issue.created_at),
    raw: p,
  }
}

function pull(p: PullRequestEventT, ctx: ParseContext): RawEvent {
  const ref = threadRef(p.repository.full_name, p.pull_request.number, true)
  const merged = p.action === 'closed' && Boolean(p.pull_request.merged || p.pull_request.merged_at)
  return {
    ...base('pr', ctx),
    // A merged closure is new evidence, not a redelivery of the opened PR. Keeping a
    // distinct source ref preserves the immutable input row while sharing its thread.
    sourceRef: merged ? `${ref}:merged` : ref,
    threadKey: ref,
    actor: actor(p.pull_request.user),
    title: p.pull_request.title,
    body: p.pull_request.body ?? '',
    createdAt: new Date(p.pull_request.created_at),
    raw: p,
  }
}

/**
 * A comment shares its parent's threadKey, so a 30-comment issue is ONE unit of
 * work rather than 30 triage runs (§7.3). sourceRef stays comment-specific so
 * redelivery of one comment is still idempotent.
 */
function comment(p: IssueCommentEventT, ctx: ParseContext): RawEvent {
  const isPull = Boolean(p.issue.pull_request)
  const parent = threadRef(p.repository.full_name, p.issue.number, isPull)
  return {
    ...base('comment', ctx),
    sourceRef: `${parent}:comment:${p.comment.id}`,
    threadKey: parent,
    actor: actor(p.comment.user),
    title: `Re: ${p.issue.title}`,
    body: p.comment.body ?? '',
    createdAt: new Date(p.comment.created_at),
    raw: p,
  }
}
