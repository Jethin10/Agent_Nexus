import { linearWriter, slackWriter, type LinearWriter, type SlackWriter } from '@ascendant/connectors'
import { db as defaultDb, type Db } from '@ascendant/db'
import { connectionForOrg } from './connections.js'

/**
 * Delivery's outbound side channels: Linear for state, Slack for notification.
 *
 * Both are **optional and non-fatal**. §8.1 makes the PR the deliverable; a Slack
 * workspace that never installed the app, or a Linear workspace with renamed states,
 * must not fail a run that already produced a reviewable PR. So every function here
 * returns a result object rather than throwing, and the caller traces the failure.
 *
 * This mirrors `repoFromEnv()` in `repo.ts`: configuration lives in the environment and
 * absence means "not configured", not "broken".
 */

export function slackFromEnv(): SlackWriter | undefined {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL_ID
  if (!token || !channel) return undefined
  return slackWriter({ token, channel })
}

/** Resolve the organization's installed Slack workspace, retaining env-based local setup. */
export async function slackForOrg(orgId: string, database: Db = defaultDb()): Promise<SlackWriter | undefined> {
  const connection = await connectionForOrg(database, orgId, 'slack')
  return connection
    ? slackWriter({ token: connection.botToken, channel: connection.channelId })
    : slackFromEnv()
}

export function linearFromEnv(): LinearWriter | undefined {
  const token = process.env.LINEAR_API_KEY
  const teamId = process.env.LINEAR_TEAM_ID
  if (!token || !teamId) return undefined
  return linearWriter({ token, teamId })
}

/** Either the side effect happened, or it did not and here is why. Never throws. */
export type NotifyResult =
  | { status: 'ok'; detail: Record<string, unknown> }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

export async function createLinearWorkItem(
  writer: LinearWriter | undefined,
  args: { title: string; description: string; decisionId: string },
): Promise<NotifyResult> {
  if (!writer) return { status: 'skipped', reason: 'linear not configured' }
  try {
    const issue = await writer.createIssue(args)
    return {
      status: 'ok',
      detail: { id: issue.id, identifier: issue.identifier, url: issue.url },
    }
  } catch (err) {
    return { status: 'failed', reason: reason(err) }
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Posts the delivery summary, or edits the existing message when the ticket already has
 * one. The `ts` round-trip is what keeps a channel to one message per ticket (§8.3).
 */
export async function notifySlack(
  writer: SlackWriter | undefined,
  args: {
    text: string
    /** Existing message timestamp, if this ticket has already been posted about. */
    ts?: string | null
    prUrl?: string
    decisionId: string
  },
): Promise<NotifyResult> {
  if (!writer) return { status: 'skipped', reason: 'slack not configured' }

  // §4.3: a click emits the event a `waitForEvent` is blocked on, so the value has to
  // carry the decision id — the handler cannot recover it from the message alone.
  const buttons = [
    { text: 'Approve', actionId: 'ascendant_approve', value: args.decisionId, style: 'primary' as const },
    { text: 'Escalate to me', actionId: 'ascendant_escalate', value: args.decisionId },
    { text: 'Reject decision', actionId: 'ascendant_reject', value: args.decisionId, style: 'danger' as const },
  ]

  const text = args.prUrl ? `${args.text}\n<${args.prUrl}|View the pull request>` : args.text

  try {
    const msg = args.ts
      ? await writer.update(args.ts, text, buttons)
      : await writer.post(text, buttons)
    return { status: 'ok', detail: { channel: msg.channel, ts: msg.ts } }
  } catch (err) {
    return { status: 'failed', reason: reason(err) }
  }
}

/**
 * Moves the Linear issue to its pipeline stage and leaves the PR link as a comment.
 *
 * A missing issue id is `skipped` rather than an error: the ticket is authoritative
 * locally (§9), and Linear having never been wired up is a normal configuration.
 */
export async function notifyLinear(
  writer: LinearWriter | undefined,
  args: {
    issueId?: string | null
    stage: 'Triage' | 'Todo' | 'In Progress' | 'In Review' | 'Done'
    comment?: string
  },
): Promise<NotifyResult> {
  if (!writer) return { status: 'skipped', reason: 'linear not configured' }
  if (!args.issueId) return { status: 'skipped', reason: 'ticket has no linear issue' }

  try {
    await writer.moveTo(args.issueId, args.stage)
    // The comment is secondary — a failed comment must not report the move as failed,
    // because the state transition is the part the board actually shows.
    let commented = false
    if (args.comment) {
      try {
        await writer.comment(args.issueId, args.comment)
        commented = true
      } catch {
        commented = false
      }
    }
    return { status: 'ok', detail: { stage: args.stage, commented } }
  } catch (err) {
    return { status: 'failed', reason: reason(err) }
  }
}
