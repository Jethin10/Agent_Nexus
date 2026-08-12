import {
  db,
  finishRun,
  getArtifact,
  latestArtifact,
  saveArtifact,
  startRun,
  trace,
} from '@ascendant/db'
import { qa } from '@ascendant/agents'
import { selectDriver, runTests, SandboxError } from '@ascendant/sandbox'
import { inngest } from './events.js'
import { flushTraces, openRun } from './runtime.js'
import { applyDiff, repoClient, repoFromEnv } from './repo.js'
import { ticketById, updateTicket } from './tickets.js'
import { linearFromEnv, notifyLinear, notifySlack, slackFromEnv } from './notify.js'

/**
 * Function 4 of 5 — `qa`. Runs the tests in a sandbox and asks the QA agent what the
 * output means.
 *
 * The agent never runs anything itself (R1): the driver produces two `ExecResult`s and
 * the agent reads them. That split is what makes a QA verdict replayable from stored
 * rows — the sandbox output is an artifact, so the same judgement can be re-derived
 * without re-running a microVM.
 */
export const qaFn = inngest.createFunction(
  {
    id: 'qa',
    name: 'QA',
    /** Sandboxes are the slowest step; two at a time leaves room for triage. */
    concurrency: { limit: 2 },
    retries: 1,
  },
  { event: 'review/ready' },
  async ({ event, step, runId }) => {
    const { orgId, ticketId, diffArtifactId } = event.data

    const run = await step.run('open-run', async () => {
      const r = await startRun(db(), {
        orgId,
        fn: 'qa',
        ticketId,
        inngestRunId: runId,
        meta: { diffArtifactId },
      })
      return { id: r.id }
    })

    const repo = await repoFromEnv()

    /**
     * The sandbox step is deliberately one `step.run`. Everything inside it — create,
     * write, install, baseline, diff run, re-runs, destroy — is a single Inngest
     * execution, because a sandbox handle cannot survive a step boundary: Inngest
     * serializes step return values, and a live microVM is not serializable.
     */
    const tested = await step.run('run-tests', async () => {
      const ctx = await openRun({ orgId, ticketId, runId: run.id })

      const diffRow = await getArtifact(ctx.db, orgId, diffArtifactId)
      if (!diffRow) throw new Error(`qa: diff artifact ${diffArtifactId} not found`)

      let driver
      try {
        driver = selectDriver({
          E2B_API_KEY: process.env.E2B_API_KEY,
          E2B_TEMPLATE_ID: process.env.E2B_TEMPLATE_ID,
          GITHUB_TOKEN: repo?.token,
          GITHUB_OWNER: repo?.owner,
          GITHUB_REPO: repo?.repo,
          ACTIONS_WORKFLOW: process.env.ACTIONS_WORKFLOW,
        })
      } catch (err) {
        /**
         * No sandbox at all is not a test failure. §13.8: a repo with no usable test
         * signal caps confidence, so the honest outcome is "inconclusive" and a human
         * reads the diff — never a green tick the pipeline did not earn.
         */
        if (!(err instanceof SandboxError)) throw err
        await trace(ctx.db, {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'qa',
          phase: 'no_sandbox',
          summary: `No sandbox driver is available, so this diff has no test signal: ${err.message}`,
          detail: { code: err.code },
        })
        return { verdict: 'inconclusive' as const, testLogArtifactId: null, failures: [] }
      }

      if (!repo) {
        await trace(ctx.db, {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'qa',
          phase: 'no_sandbox',
          summary: 'No repository is configured, so there is nothing to run tests against.',
        })
        return { verdict: 'inconclusive' as const, testLogArtifactId: null, failures: [] }
      }

      // The sandbox needs the repo's files; it cannot fetch them itself, because its
      // egress allowlist is the package registry only (§12.4).
      const client = repoClient(repo)
      const planArtifact = await latestArtifact(ctx.db, orgId, ticketId, 'plan')
      const readPaths = collectPaths(planArtifact?.content, diffRow.content)
      const baselineFiles = await client.readFiles(readPaths)
      const applied = applyDiff(baselineFiles, diffRow.content)

      if (applied.failed.length > 0) {
        /**
         * §14.3: a diff that does not apply is a rebase-and-retry, then an ESCALATE.
         * There is no fuzzy apply here — testing a file nobody wrote would produce a
         * verdict about nothing.
         */
        await trace(ctx.db, {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'qa',
          phase: 'diff_did_not_apply',
          summary: `The diff does not apply to ${applied.failed.join(', ')} — the base has moved.`,
          detail: { failed: applied.failed },
        })
        return { verdict: 'inconclusive' as const, testLogArtifactId: null, failures: [] }
      }

      const testCommand = (process.env.ASCENDANT_TEST_COMMAND ?? 'pnpm test').split(' ')
      const result = await runTests({
        driver,
        files: applied.files,
        baselineFiles,
        testCommand,
      })

      const verdictOut = await qa(ctx.agent, {
        diff: diffRow.content,
        baseline: { exitCode: result.baseline.exitCode, output: combine(result.baseline) },
        after: { exitCode: result.after.exitCode, output: combine(result.after) },
        reruns: result.reruns.map((r) => ({ exitCode: r.exitCode, output: combine(r) })),
      })

      const log = await saveArtifact(ctx.db, {
        orgId,
        ticketId,
        runId: run.id,
        kind: 'test_log',
        agent: 'qa',
        content: [
          `# baseline (exit ${result.baseline.exitCode})`,
          combine(result.baseline),
          `\n# after the diff (exit ${result.after.exitCode})`,
          combine(result.after),
          ...result.reruns.map((r, i) => `\n# re-run ${i + 1} (exit ${r.exitCode})\n${combine(r)}`),
        ].join('\n'),
        meta: {
          driver: driver.id,
          baselineExit: result.baseline.exitCode,
          afterExit: result.after.exitCode,
          verdict: verdictOut.verdict,
          flaky: verdictOut.flaky,
        },
      })

      await flushTraces(ctx, { ticketId, runId: run.id })

      return {
        verdict: verdictOut.verdict,
        testLogArtifactId: log.id,
        failures: verdictOut.failures.map((f) => f.test),
      }
    })

    /**
     * A red suite loops back to the Coder exactly once, via `work/accepted`, which
     * re-enters plan-and-code with the failures on the trace. §4.2 caps coder retries
     * at 2 and that cap is enforced inside the debate loop, so this cannot ping-pong.
     */
    if (tested.verdict === 'fail') {
      await step.run('mark-failed', async () => {
        await trace(db(), {
          orgId,
          ticketId,
          runId: run.id,
          agent: 'qa',
          phase: 'failed',
          summary: `Tests failed: ${tested.failures.join(', ') || 'see the test log'}`,
          detail: { failures: tested.failures, testLogArtifactId: tested.testLogArtifactId },
        })
        await updateTicket(db(), orgId, ticketId, { status: 'blocked' })
        await finishRun(db(), orgId, run.id, 'succeeded')
      })
      return { ticketId, status: 'tests_failed', failures: tested.failures }
    }

    await step.run('notify-review-ready', async () => {
      const ticket = await ticketById(db(), orgId, ticketId)
      const [linear, slack] = await Promise.all([
        notifyLinear(linearFromEnv(), { issueId: ticket.linearId, stage: 'In Review' }),
        notifySlack(slackFromEnv(), {
          text: `*QA ${tested.verdict.toUpperCase()}* — ${ticket.title}\nThe diff is ready for delivery.`,
          ts: ticket.slackTs,
          decisionId: ticket.decisionId,
        }),
      ])
      await trace(db(), {
        orgId, ticketId, runId: run.id, agent: 'qa', phase: 'review_ready_notified',
        summary: `Review ready; Linear ${linear.status}, Slack ${slack.status}.`,
        detail: { linear, slack },
      })
    })

    await step.sendEvent('request-delivery', {
      name: 'delivery/ready',
      data: {
        orgId,
        ticketId,
        diffArtifactId,
        ...(tested.testLogArtifactId ? { testLogArtifactId: tested.testLogArtifactId } : {}),
      },
    })

    await step.run('close-run', async () => {
      await updateTicket(db(), orgId, ticketId, { status: 'delivering' })
      await finishRun(db(), orgId, run.id, 'succeeded')
    })

    return { ticketId, status: tested.verdict }
  },
)

function combine(r: { stdout: string; stderr: string; timedOut: boolean }): string {
  return [r.stdout, r.stderr, r.timedOut ? '[killed on the sandbox wall clock]' : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 40_000)
}

/**
 * Which files the sandbox needs. The diff's own paths are not enough: a test imports
 * the module it tests, and `pnpm test` needs the manifest and config. Kept to a
 * bounded list rather than the whole repo, since Inngest step state caps at 32 MB.
 */
function collectPaths(planJson: string | undefined, diff: string): string[] {
  const paths = new Set<string>([
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'vitest.config.ts',
  ])

  for (const m of diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
    const p = m[1]?.trim()
    if (p && p !== '/dev/null') paths.add(p)
  }

  if (planJson) {
    try {
      const parsed = JSON.parse(planJson) as {
        research?: { files?: { path?: string }[] }
        plan?: { filesTouched?: string[] }
      }
      for (const f of parsed.research?.files ?? []) if (f.path) paths.add(f.path)
      for (const p of parsed.plan?.filesTouched ?? []) paths.add(p)
    } catch {
      // A malformed plan artifact should not stop the tests running.
    }
  }

  return [...paths].slice(0, 40)
}
