import { z } from 'zod'

/**
 * Only the fields this system actually reads. GitHub payloads are enormous and
 * their unread parts change without notice, so everything else is left to
 * `.passthrough()` and preserved verbatim in RawEvent.raw for replay.
 */
const GhUser = z
  .object({
    id: z.number(),
    login: z.string(),
    type: z.string().optional(),
  })
  .passthrough()

const GhRepo = z
  .object({
    full_name: z.string(),
    default_branch: z.string().optional(),
  })
  .passthrough()

const GhIssue = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    user: GhUser.nullable().optional(),
    created_at: z.string(),
    html_url: z.string().optional(),
    pull_request: z.unknown().optional(), // present => this "issue" is a PR
  })
  .passthrough()

const GhPull = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    user: GhUser.nullable().optional(),
    created_at: z.string(),
    html_url: z.string().optional(),
    draft: z.boolean().optional(),
  })
  .passthrough()

const GhComment = z
  .object({
    id: z.number(),
    body: z.string().nullable().optional(),
    user: GhUser.nullable().optional(),
    created_at: z.string(),
    html_url: z.string().optional(),
  })
  .passthrough()

export const IssuesEvent = z
  .object({
    action: z.string(),
    repository: GhRepo,
    issue: GhIssue,
    sender: GhUser.optional(),
  })
  .passthrough()

export const PullRequestEvent = z
  .object({
    action: z.string(),
    repository: GhRepo,
    pull_request: GhPull,
    sender: GhUser.optional(),
  })
  .passthrough()

export const IssueCommentEvent = z
  .object({
    action: z.string(),
    repository: GhRepo,
    issue: GhIssue,
    comment: GhComment,
    sender: GhUser.optional(),
  })
  .passthrough()

export type IssuesEvent = z.infer<typeof IssuesEvent>
export type PullRequestEvent = z.infer<typeof PullRequestEvent>
export type IssueCommentEvent = z.infer<typeof IssueCommentEvent>

/** Bots are rejected deterministically at triage (§5.3 bot_author). */
export function isBot(u: { login: string; type?: string | undefined } | null | undefined): boolean {
  if (!u) return false
  return u.type === 'Bot' || /\[bot\]$/.test(u.login)
}
