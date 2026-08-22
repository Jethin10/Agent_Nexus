import {
  db,
  finishRun,
  getDecision,
  latestArtifact,
  repeatedObjections,
  saveArtifact,
  startRun,
  trace,
} from '@ascendant/db'
import { code, plan, research, review } from '@ascendant/agents'
import { LIMITS, scanDiff } from '@ascendant/core'
import { inngest } from './events.js'
import { flushTraces, openRun } from './runtime.js'
import { repoClient, repoForOrg } from './repo.js'
import { ticketById, updateTicket } from './tickets.js'
import { linearFromEnv, notifyLinear, notifySlack, slackForOrg } from './notify.js'

/**
 * Function 3 of 5 — `plan-and-code`. §4.2's bounded debate.
 *
 * Each *round* is one `step.run()`, with the multi-turn argument as a plain `for` loop
 * of LLM calls **inside** that step. Inngest sees ~6 steps per ticket rather than 20,
 * which is what makes this fit inside 5 concurrent executions where a wide fan-out of
 * debate agents would queue immediately.
 *
 * The cost of that choice: if the process dies mid-round, the round replays from its
 * start. Rounds are 30-90s, so that is the right trade.
 *
 * Every cap hit here is an ESCALATE with the transcript attached, never a crash and
 * never a truncated plan that looks finished.
 */
export const planAndCodeFn = inngest.createFunction(
  {
    id: 'plan-and-code',
    name: 'Plan and code',
    concurrency: { limit: 2 },
    retries: 1,
  },
  { event: 'work/accepted' },
  async ({ event, step, runId }) => {
    const { orgId, ticketId, decisionId } = event.data

    const run = await step.run('open-run', async () => {
      const r = await startRun(db(), {
        orgId,
        fn: 'plan-and-code',
        ticketId,
        inngestRunId: runId,
        meta: { decisionId },
      })
      return { id: r.id }
    })

    const repo = await repoForOrg(orgId)
    if (!repo) {
      await step.run('no-repo', async () => {
        await trace(db(), {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'orchestrator',
          phase: 'blocked',
          summary: 'No GitHub repository is configured, so no code can be written for this ticket.',
          detail: {
            need: [
              'GITHUB_OWNER',
              'GITHUB_REPO',
              'GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_BASE64 (or explicitly enabled GITHUB_TOKEN locally)',
            ],
          },
        })
        await updateTicket(db(), orgId, ticketId, { status: 'blocked' })
        await finishRun(db(), orgId, run.id, 'failed', { error: 'no repo configured' })
      })
      return { ticketId, status: 'blocked', reason: 'no_repo' }
    }

    await step.run('mark-coding', async () => {
      const ticket = await ticketById(db(), orgId, ticketId)
      await updateTicket(db(), orgId, ticketId, { status: 'coding' })
      const [linear, slack] = await Promise.all([
        notifyLinear(linearFromEnv(), { issueId: ticket.linearId, stage: 'In Progress' }),
        notifySlack(await slackForOrg(orgId), {
          text: `*IN PROGRESS* — ${ticket.title}\nResearch, planning, coding and review are running.`,
          ts: ticket.slackTs,
          decisionId,
        }),
      ])
      await trace(db(), {
        orgId, ticketId, runId: run.id, agent: 'orchestrator', phase: 'coding_started',
        summary: `Coding started; Linear ${linear.status}, Slack ${slack.status}.`,
        detail: { linear, slack },
      })
    })

    // ── round 1: research, then Planner proposes → Reviewer critiques → revises ──
    const planned = await step.run('round-1-plan', async () => {
      const ctx = await openRun({ orgId, ticketId, runId: run.id })
      const ticket = await ticketById(ctx.db, orgId, ticketId)
      const decision = await getDecision(ctx.db, orgId, decisionId)
      const client = repoClient(repo)

      // §11.3 signal three: objections the Reviewer has raised 3+ times become part
      // of the Coder's conventions, mined from this system's own trace.
      const mined = await repeatedObjections(ctx.db, orgId)
      const conventions = mined.map((m) => `${m.rule} (raised ${m.n} times)`)

      const fileList = await client.listFiles()
      const mapped = await research(ctx.agent, {
        title: ticket.title,
        statement: ticket.statement,
        fileList,
        ...(decision
          ? { priorRefs: decision.citations.map((c) => ({ ref: c.ref, quote: c.quote })) }
          : {}),
      })

      const files = Object.entries(await client.readFiles(mapped.files.map((f) => f.path))).map(
        ([path, content]) => ({ path, content }),
      )

      let proposal = await plan(ctx.agent, {
        title: ticket.title,
        statement: ticket.statement,
        research: mapped,
        files,
        conventions,
        round: 1,
      })

      /**
       * The debate: Reviewer critiques the plan, Planner revises. A plain loop inside
       * one step, so the whole argument costs Inngest one execution.
       */
      for (let round = 1; round < LIMITS.MAX_DEBATE_ROUNDS && proposal.verdict === 'plan'; round += 1) {
        const critique = await review(ctx.agent, {
          plan: proposal,
          diff: '(no diff yet — this is a review of the plan itself)',
          scan: scanDiff(''),
          conventions,
          round,
        })
        if (critique.verdict === 'approve') break

        proposal = await plan(ctx.agent, {
          title: ticket.title,
          statement: ticket.statement,
          research: mapped,
          files,
          conventions,
          critique,
          round: round + 1,
        })
      }

      const artifact = await saveArtifact(ctx.db, {
        orgId,
        ticketId,
        runId: run.id,
        kind: 'plan',
        agent: 'planner',
        content: JSON.stringify({ research: mapped, plan: proposal }, null, 2),
        meta: { verdict: proposal.verdict, filesTouched: proposal.filesTouched },
      })

      await flushTraces(ctx, { ticketId, runId: run.id })

      return {
        verdict: proposal.verdict,
        escalateReason: proposal.escalateReason ?? null,
        planArtifactId: artifact.id,
        conventions,
        readPaths: files.map((f) => f.path),
        statement: proposal.statement,
        steps: proposal.steps,
      }
    })

    if (planned.verdict === 'escalate') {
      await step.run('escalate-plan', async () => {
        await trace(db(), {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'planner',
          phase: 'escalated',
          summary: `ESCALATE — ${planned.escalateReason ?? 'the Planner declined to plan this'}`,
          detail: { planArtifactId: planned.planArtifactId },
        })
        await updateTicket(db(), orgId, ticketId, { status: 'blocked' })
        await finishRun(db(), orgId, run.id, 'succeeded')
      })
      return { ticketId, status: 'escalated', reason: planned.escalateReason }
    }

    // ── round 2: Coder writes → Reviewer critiques → Coder revises ──────────────
    const coded = await step.run('round-2-code', async () => {
      const ctx = await openRun({ orgId, ticketId, runId: run.id })
      const ticket = await ticketById(ctx.db, orgId, ticketId)
      const client = repoClient(repo)
      const files = Object.entries(await client.readFiles(planned.readPaths)).map(
        ([path, content]) => ({ path, content }),
      )

      const proposal = { statement: planned.statement, steps: planned.steps }
      let written = await code(ctx.agent, {
        title: ticket.title,
        statement: ticket.statement,
        plan: proposal,
        files,
        conventions: planned.conventions,
        round: 1,
      })
      let verdict = await review(ctx.agent, {
        plan: proposal,
        diff: written.diff,
        scan: written.scan,
        conventions: planned.conventions,
        round: 1,
      })

      for (
        let round = 1;
        round <= LIMITS.MAX_CODER_RETRIES && verdict.verdict !== 'approve';
        round += 1
      ) {
        written = await code(ctx.agent, {
          title: ticket.title,
          statement: ticket.statement,
          plan: proposal,
          files,
          conventions: planned.conventions,
          critique: verdict,
          round: round + 1,
        })
        verdict = await review(ctx.agent, {
          plan: proposal,
          diff: written.diff,
          scan: written.scan,
          conventions: planned.conventions,
          round: round + 1,
        })
      }

      const diffArtifact = await saveArtifact(ctx.db, {
        orgId,
        ticketId,
        runId: run.id,
        kind: 'diff',
        agent: 'coder',
        content: written.diff,
        meta: {
          filesTouched: written.scan.parsed.files.map((f) => f.path),
          added: written.scan.parsed.addedLines,
          removed: written.scan.parsed.removedLines,
          findings: written.scan.findings,
        },
      })

      await saveArtifact(ctx.db, {
        orgId,
        ticketId,
        runId: run.id,
        kind: 'review',
        agent: 'reviewer',
        content: JSON.stringify(verdict, null, 2),
        meta: { verdict: verdict.verdict, comments: verdict.comments.length },
      })

      await flushTraces(ctx, { ticketId, runId: run.id })

      return {
        diffArtifactId: diffArtifact.id,
        reviewVerdict: verdict.verdict,
        mustEscalate: written.scan.mustEscalate,
        findings: written.scan.findings.map((f) => f.rule),
        readPaths: planned.readPaths,
      }
    })

    /**
     * A diff the deterministic scan rejected does not proceed to QA. Running tests on
     * a diff that adds an `eval` would be theatre: the outcome is already ESCALATE
     * regardless of whether the suite goes green.
     */
    if (coded.mustEscalate || coded.reviewVerdict === 'reject') {
      await step.run('escalate-diff', async () => {
        await trace(db(), {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'reviewer',
          phase: 'escalated',
          summary: `ESCALATE — the diff was rejected${
            coded.findings.length ? `: ${coded.findings.join(', ')}` : ''
          }`,
          detail: { findings: coded.findings, diffArtifactId: coded.diffArtifactId },
        })
        await updateTicket(db(), orgId, ticketId, { status: 'blocked' })
        await finishRun(db(), orgId, run.id, 'succeeded')
      })
      return { ticketId, status: 'escalated', reason: 'diff_rejected', findings: coded.findings }
    }

    await step.run('mark-reviewing', () =>
      updateTicket(db(), orgId, ticketId, { status: 'qa' }),
    )

    await step.sendEvent('request-qa', {
      name: 'review/ready',
      data: { orgId, ticketId, diffArtifactId: coded.diffArtifactId, round: 1 },
    })

    await step.run('close-run', () => finishRun(db(), orgId, run.id, 'succeeded'))
    return { ticketId, status: 'coded', diffArtifactId: coded.diffArtifactId }
  },
)

/** Re-read the diff for the QA function, which receives only its id (R2). */
export async function diffForTicket(orgId: string, ticketId: string): Promise<string | undefined> {
  const row = await latestArtifact(db(), orgId, ticketId, 'diff')
  return row?.content
}
