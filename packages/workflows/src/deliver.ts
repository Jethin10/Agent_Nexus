import {
  db,
  finishRun,
  getArtifact,
  getDecision,
  latestArtifact,
  recordOutcome,
  saveArtifact,
  startRun,
  ticketTrace,
  trace,
} from '@ascendant/db'
import { deliver as buildDelivery } from '@ascendant/agents'
import { scanDiff } from '@ascendant/core'
import { inngest } from './events.js'
import { openRun } from './runtime.js'
import { applyDiff, repoClient, repoFromEnv } from './repo.js'
import { githubWriter } from './github-write.js'
import { ticketById, updateTicket } from './tickets.js'
import { linearFromEnv, notifyLinear, notifySlack, slackFromEnv } from './notify.js'

/**
 * Function 5 of 5 — `deliver`. The pipeline's output is never a silent commit: it is
 * always a reviewable artifact plus a state change plus a notification, and all three
 * are idempotent.
 *
 * The push happens here, from the workflow, after the diff was read back out of the
 * sandbox — never from inside it (§12.4).
 */
export const deliverFn = inngest.createFunction(
  {
    id: 'deliver',
    name: 'Deliver',
    concurrency: { limit: 2 },
    retries: 2,
  },
  { event: 'delivery/ready' },
  async ({ event, step, runId }) => {
    const { orgId, ticketId, diffArtifactId, testLogArtifactId } = event.data

    const run = await step.run('open-run', async () => {
      const r = await startRun(db(), {
        orgId,
        fn: 'deliver',
        ticketId,
        inngestRunId: runId,
        meta: { diffArtifactId },
      })
      return { id: r.id }
    })

    /**
     * The PR body is built by template with no model call at all (agent 8), so this
     * step cannot fail on a rate limit and cannot embellish. `Why` is the triage
     * reasoning verbatim, because it is the audit trail rather than a paraphrase.
     */
    const built = await step.run('build-artifacts', async () => {
      const ctx = await openRun({ orgId, ticketId, runId: run.id })
      const ticket = await ticketById(ctx.db, orgId, ticketId)
      const decision = await getDecision(ctx.db, orgId, ticket.decisionId)
      if (!decision) throw new Error(`deliver: decision ${ticket.decisionId} not found`)

      const diffRow = await getArtifact(ctx.db, orgId, diffArtifactId)
      if (!diffRow) throw new Error(`deliver: diff artifact ${diffArtifactId} not found`)

      const planRow = await latestArtifact(ctx.db, orgId, ticketId, 'plan')
      const reviewRow = await latestArtifact(ctx.db, orgId, ticketId, 'review')
      const logRow = testLogArtifactId
        ? await getArtifact(ctx.db, orgId, testLogArtifactId)
        : undefined

      const parsedPlan = safeJson<{
        plan?: {
          statement?: string
          steps?: { order: number; path: string; change: string }[]
          risks?: { risk: string; level: string }[]
          testPlan?: string[]
        }
      }>(planRow?.content)?.plan

      const parsedReview = safeJson<{
        verdict?: 'approve' | 'revise' | 'reject'
        summary?: string
        comments?: {
          path: string
          line?: number
          severity: 'blocker' | 'major' | 'minor' | 'nit'
          comment: string
          rule?: string
        }[]
      }>(reviewRow?.content)

      // The Run Detail timeline is the debate, so the PR's collapsed summary is drawn
      // from the same rows the dashboard renders rather than a second transcript.
      const timeline = await ticketTrace(ctx.db, orgId, ticketId)
      const debate = timeline
        .filter((t) => ['planner', 'coder', 'reviewer', 'qa'].includes(t.agent))
        .map((t) => ({ agent: t.agent, round: t.round ?? undefined, summary: t.summary }))

      const qaMeta = logRow?.meta as
        | { verdict?: string; flaky?: string[]; afterExit?: number }
        | undefined

      const delivery = buildDelivery(
        {
          ticket: {
            title: ticket.title,
            statement: ticket.statement,
            linearIdentifier: ticket.linearIdentifier ?? undefined,
          },
          decision: {
            id: decision.id,
            outcome: decision.outcome,
            confidence: decision.confidence,
            reasoning: decision.reasoning,
            citations: decision.citations,
          },
          plan: {
            statement: parsedPlan?.statement ?? ticket.statement,
            steps: parsedPlan?.steps ?? [],
            risks: parsedPlan?.risks ?? [],
            testPlan: parsedPlan?.testPlan ?? [],
          },
          debate,
          reviews: parsedReview
            ? [
                {
                  verdict: parsedReview.verdict ?? 'revise',
                  summary: parsedReview.summary ?? '',
                  comments: parsedReview.comments ?? [],
                },
              ]
            : [],
          ...(qaMeta?.verdict
            ? {
                qa: {
                  verdict: qaMeta.verdict,
                  summary: `Suite exited ${qaMeta.afterExit ?? 0}.`,
                  failures: [],
                  flaky: qaMeta.flaky ?? [],
                },
              }
            : {}),
          scan: scanDiff(diffRow.content),
          testCommands: [process.env.ASCENDANT_TEST_COMMAND ?? 'pnpm test'],
        },
        { autonomousThreshold: ctx.policy.bands.autonomous },
      )

      const bodyArtifact = await saveArtifact(ctx.db, {
        orgId,
        ticketId,
        runId: run.id,
        kind: 'pr_body',
        agent: 'delivery',
        content: delivery.prBody,
        meta: { branch: delivery.branch, isDraft: delivery.isDraft },
      })

      return {
        ...delivery,
        prBodyArtifactId: bodyArtifact.id,
        diff: diffRow.content,
        decisionId: decision.id,
        eventRef: ticket.linearIdentifier ?? null,
        /**
         * Read here rather than in the notify step because Inngest serializes step
         * returns: re-reading the ticket there would see a row a concurrent retry may
         * have already updated, and post a second Slack message instead of editing.
         */
        linearId: ticket.linearId ?? null,
        slackTs: ticket.slackTs ?? null,
      }
    })

    const repo = repoFromEnv()
    if (!repo) {
      await step.run('no-repo', async () => {
        await trace(db(), {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'delivery',
          phase: 'blocked',
          summary:
            'The PR body and commit message are ready, but no GitHub repository is configured to push them to.',
          detail: { prBodyArtifactId: built.prBodyArtifactId, branch: built.branch },
        })
        await finishRun(db(), orgId, run.id, 'failed', { error: 'no repo configured' })
      })
      return { ticketId, status: 'blocked', reason: 'no_repo', branch: built.branch }
    }

    const pushed = await step.run('open-pr', async () => {
      const client = repoClient(repo)
      const writer = githubWriter(repo)

      const baseSha = await client.headSha()
      const paths = [...built.diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)]
        .map((m) => m[1]?.trim())
        .filter((p): p is string => Boolean(p) && p !== '/dev/null')

      const current = await client.readFiles(paths)
      const applied = applyDiff(current, built.diff)
      if (applied.failed.length > 0) {
        throw new Error(
          `deliver: the diff no longer applies to ${applied.failed.join(', ')} — the base moved since QA`,
        )
      }

      const files = paths.map((path) => ({ path, content: applied.files[path] }))

      const pr = await writer.openPr({
        branch: built.branch,
        baseSha,
        base: repo.ref ?? 'main',
        commitMessage: built.commitMessage,
        files,
        title: built.prTitle,
        body: built.prBody,
        draft: built.isDraft,
        labels: ['ascendant'],
      })

      await updateTicket(db(), orgId, ticketId, {
        status: 'done',
        branch: pr.branch,
        prNumber: pr.number,
        prUrl: pr.url,
        prIsDraft: pr.isDraft,
        closedAt: new Date(),
      })

      await trace(db(), {
        orgId,
        ticketId,
        runId: run.id,
        agent: 'delivery',
        phase: 'shipped',
        summary: `${pr.isDraft ? 'Draft PR' : 'PR'} #${pr.number} opened on ${pr.branch}`,
        detail: {
          prUrl: pr.url,
          commitSha: pr.commitSha,
          decisionTrailer: built.decisionId,
          isDraft: pr.isDraft,
        },
      })

      return { number: pr.number, url: pr.url, isDraft: pr.isDraft }
    })

    /**
     * The notification and the board update. Both are best-effort by design: the PR is
     * the deliverable (§8.1), and a Slack workspace that never installed the app must
     * not fail a run that already produced a reviewable PR. Failures are traced, not
     * thrown — which is why this is not wrapped in a retrying step that could undo the
     * push above.
     */
    await step.run('notify', async () => {
      const slack = await notifySlack(slackFromEnv(), {
        text: built.slackSummary,
        ts: built.slackTs,
        prUrl: pushed.url,
        decisionId: built.decisionId,
      })

      if (slack.status === 'ok') {
        const detail = slack.detail as { channel?: string; ts?: string }
        // Persist the timestamp so the next stage edits this message rather than
        // posting a second one.
        if (detail.ts) {
          await updateTicket(db(), orgId, ticketId, {
            slackChannel: detail.channel ?? null,
            slackTs: detail.ts,
          })
        }
      }

      const linear = await notifyLinear(linearFromEnv(), {
        issueId: built.linearId,
        stage: 'In Review',
        comment: `${pushed.isDraft ? 'Draft PR' : 'PR'} #${pushed.number} is open: ${pushed.url}`,
      })

      // One trace row covering both, so a run that shipped but could not notify is
      // visible in the timeline instead of looking like a clean delivery.
      const degraded = [
        ...(slack.status === 'failed' ? [`Slack: ${slack.reason}`] : []),
        ...(linear.status === 'failed' ? [`Linear: ${linear.reason}`] : []),
      ]

      await trace(db(), {
        orgId,
        ticketId,
        runId: run.id,
        agent: 'delivery',
        phase: 'notified',
        summary:
          degraded.length > 0
            ? `PR #${pushed.number} shipped, but ${degraded.length} notification${degraded.length > 1 ? 's' : ''} failed.`
            : `Notified: Slack ${slack.status}, Linear ${linear.status}.`,
        detail: { slack, linear, ...(degraded.length > 0 ? { degraded } : {}) },
      })
    })

    /**
     * Seeds the learning loop. §11.3: what happens to this PR — merged, closed
     * unmerged, reverted — is the signal that makes "the system improves" a claim with
     * a table behind it rather than a gesture at an arrow in a diagram.
     */
    await step.run('seed-outcome', async () => {
      await recordOutcome(db(), {
        orgId,
        decisionId: built.decisionId,
        ticketId,
        kind: 'pr_opened',
        note: `${pushed.isDraft ? 'draft ' : ''}PR #${pushed.number}`,
        meta: { prUrl: pushed.url, prNumber: pushed.number },
      })
      await finishRun(db(), orgId, run.id, 'succeeded')
    })

    return {
      ticketId,
      status: 'delivered',
      prNumber: pushed.number,
      prUrl: pushed.url,
      isDraft: pushed.isDraft,
      slackSummary: built.slackSummary,
    }
  },
)

function safeJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
