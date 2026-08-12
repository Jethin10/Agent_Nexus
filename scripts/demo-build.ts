import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  code,
  deliver,
  orchestrate,
  plan,
  qa,
  research,
  review,
} from '@ascendant/agents'
import {
  decisionForEvent,
  finishRun,
  getDecision,
  inbox,
  saveArtifact,
  startRun,
  trace,
} from '@ascendant/db'
import { scanDiff } from '@ascendant/core'
import { localDriver, runTests } from '@ascendant/sandbox'
import {
  applyDiff,
  githubWriter,
  linearFromEnv,
  notifyLinear,
  notifySlack,
  repoClient,
  repoFromEnv,
  slackFromEnv,
  ticketById,
  updateTicket,
} from '@ascendant/workflows'
import { DATA_DIR, openLocalDb, openRunContext, ORG_ID } from './lib/context.ts'

const PUBLISH = process.argv.includes('--publish')

const BASELINE = {
  'package.json': JSON.stringify({
    name: 'ascendant-demo-api',
    private: true,
    type: 'module',
    scripts: { test: 'vitest run' },
    devDependencies: { typescript: '5.7.3', vitest: '3.0.4' },
  }, null, 2),
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true },
    include: ['src'],
  }, null, 2),
  'src/session.ts': `export interface Session {
  id: string
  expiresAt: number
}

export function getSessionId(store: Map<string, Session>, token: string): string | null {
  const session = store.get(token)
  return session.id
}
`,
  'src/session.test.ts': `import { describe, expect, it } from 'vitest'
import { getSessionId } from './session'

describe('getSessionId', () => {
  it('returns the id for a live session', () => {
    const store = new Map([['t1', { id: 's1', expiresAt: Date.now() + 60_000 }]])
    expect(getSessionId(store, 't1')).toBe('s1')
  })
})
`,
}

async function persistTraces(
  database: Awaited<ReturnType<typeof openLocalDb>>['db'],
  runId: string,
  ticketId: string,
  rows: Awaited<ReturnType<typeof openRunContext>>['traces'],
) {
  for (const row of rows.splice(0, rows.length)) {
    await trace(database, {
      orgId: ORG_ID,
      ticketId,
      runId,
      agent: row.agent,
      phase: row.phase,
      round: row.round,
      summary: row.summary,
      detail: row.detail,
      model: row.model,
      tokens: row.tokens ?? 0,
      latencyMs: row.latencyMs ?? 0,
    })
  }
}

async function main() {
  const { db, handle, migrated } = await openLocalDb()
  if (migrated) throw new Error(`No demo corpus exists at ${DATA_DIR}. Run pnpm seed:demo first.`)

  const rows = await inbox(db, ORG_ID, { query: 'acme/api#1045', limit: 10 })
  const selected = rows.find((row) => row.sourceRef === 'acme/api#1045')
  if (!selected?.decisionId || !selected.ticketId) {
    throw new Error('The ACCEPT scenario has not run. Run `pnpm demo real-bug` first.')
  }

  const [ticket, decision] = await Promise.all([
    ticketById(db, ORG_ID, selected.ticketId),
    getDecision(db, ORG_ID, selected.decisionId),
  ])
  if (!decision) throw new Error('The accepted decision disappeared.')
  const latest = await decisionForEvent(db, ORG_ID, selected.eventId)
  if (latest?.outcome !== 'ACCEPT') throw new Error('The selected scenario is no longer ACCEPT.')

  const run = await startRun(db, {
    orgId: ORG_ID,
    fn: 'demo-build',
    ticketId: ticket.id,
    meta: { fixtureRepo: true, publishRequested: PUBLISH },
  })
  const ctx = await openRunContext(db, {
    onTrace: (row) => process.stdout.write(`  ${row.agent.padEnd(12)} ${row.phase.padEnd(14)} ${row.summary}\n`),
  })

  process.stdout.write(`\nAscendant — accepted work pipeline\n`)
  process.stdout.write(`model     ${ctx.mode.label}\n`)
  process.stdout.write(`sandbox   local driver (explicit demo permission; not an isolation boundary)\n\n`)

  try {
    const sized = await orchestrate(ctx.agent, { title: ticket.title, statement: ticket.statement })
    const mapped = await research(ctx.agent, {
      title: ticket.title,
      statement: ticket.statement,
      fileList: Object.keys(BASELINE),
      priorRefs: decision.citations.map((citation) => ({ ref: citation.ref, quote: citation.quote })),
    })
    const relevant = mapped.files
      .map((file) => ({ path: file.path, content: BASELINE[file.path as keyof typeof BASELINE] }))
      .filter((file): file is { path: string; content: string } => typeof file.content === 'string')

    const proposal = await plan(ctx.agent, {
      title: ticket.title,
      statement: ticket.statement,
      research: mapped,
      files: relevant,
      conventions: [],
      round: 1,
    })
    if (proposal.verdict !== 'plan') throw new Error(proposal.escalateReason || 'Planner escalated.')

    const planReview = await review(ctx.agent, {
      plan: proposal,
      diff: '(plan review — no diff yet)',
      scan: scanDiff(''),
      round: 1,
    })
    const finalPlan = planReview.verdict === 'approve'
      ? proposal
      : await plan(ctx.agent, {
          title: ticket.title,
          statement: ticket.statement,
          research: mapped,
          files: relevant,
          conventions: [],
          critique: planReview,
          round: 2,
        })

    const written = await code(ctx.agent, {
      title: ticket.title,
      statement: ticket.statement,
      plan: finalPlan,
      files: relevant,
      conventions: [],
      round: 1,
    })
    const codeReview = await review(ctx.agent, {
      plan: finalPlan,
      diff: written.diff,
      scan: written.scan,
      round: 1,
    })
    if (codeReview.verdict !== 'approve' || written.scan.mustEscalate) {
      throw new Error(`Reviewer blocked the diff: ${codeReview.summary}`)
    }

    const applied = applyDiff(BASELINE, written.diff)
    if (applied.failed.length) throw new Error(`Diff did not apply: ${applied.failed.join(', ')}`)

    const pnpmCli = process.env.npm_execpath
    if (!pnpmCli) throw new Error('pnpm did not expose npm_execpath to the demo build.')
    const tests = await runTests({
      driver: localDriver({ allow: true }),
      baselineFiles: BASELINE,
      files: applied.files,
      // Invoke pnpm through Node so the local driver works on Windows without
      // shell=true; generated commands never pass through cmd.exe.
      installCommand: [process.execPath, pnpmCli, 'install', '--offline', '--ignore-scripts'],
      testCommand: [process.execPath, pnpmCli, 'test'],
      timeoutMs: 120_000,
    })
    const qaVerdict = await qa(ctx.agent, {
      diff: written.diff,
      baseline: { exitCode: tests.baseline.exitCode, output: combine(tests.baseline) },
      after: { exitCode: tests.after.exitCode, output: combine(tests.after) },
      reruns: tests.reruns.map((result) => ({ exitCode: result.exitCode, output: combine(result) })),
    })
    if (qaVerdict.verdict !== 'pass') throw new Error(`QA returned ${qaVerdict.verdict}: ${qaVerdict.summary}`)

    const planArtifact = await saveArtifact(db, {
      orgId: ORG_ID, ticketId: ticket.id, runId: run.id, kind: 'plan', agent: 'planner',
      content: JSON.stringify({ research: mapped, plan: finalPlan }, null, 2),
    })
    const diffArtifact = await saveArtifact(db, {
      orgId: ORG_ID, ticketId: ticket.id, runId: run.id, kind: 'diff', agent: 'coder', content: written.diff,
    })
    const reviewArtifact = await saveArtifact(db, {
      orgId: ORG_ID, ticketId: ticket.id, runId: run.id, kind: 'review', agent: 'reviewer',
      content: JSON.stringify(codeReview, null, 2),
    })
    const testLog = `# baseline (exit ${tests.baseline.exitCode})\n${combine(tests.baseline)}\n\n# after (exit ${tests.after.exitCode})\n${combine(tests.after)}`
    const testArtifact = await saveArtifact(db, {
      orgId: ORG_ID, ticketId: ticket.id, runId: run.id, kind: 'test_log', agent: 'qa', content: testLog,
      meta: { driver: 'local', baselineExit: tests.baseline.exitCode, afterExit: tests.after.exitCode, verdict: qaVerdict.verdict },
    })

    await persistTraces(db, run.id, ticket.id, ctx.traces)

    const delivery = deliver({
      ticket: { title: ticket.title, statement: ticket.statement, linearIdentifier: ticket.linearIdentifier ?? undefined },
      decision: {
        id: decision.id,
        outcome: decision.outcome,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        citations: decision.citations,
      },
      plan: finalPlan,
      debate: [],
      reviews: [codeReview],
      qa: qaVerdict,
      scan: written.scan,
      testCommands: ['pnpm test'],
    }, { autonomousThreshold: ctx.policy.bands.autonomous })

    const prBody = await saveArtifact(db, {
      orgId: ORG_ID, ticketId: ticket.id, runId: run.id, kind: 'pr_body', agent: 'delivery',
      content: delivery.prBody,
      meta: { branch: delivery.branch, isDraft: delivery.isDraft, preview: !PUBLISH },
    })

    const outputDir = join(process.cwd(), '.ascendant', 'demo-output')
    await mkdir(outputDir, { recursive: true })
    await Promise.all([
      writeFile(join(outputDir, 'change.patch'), written.diff),
      writeFile(join(outputDir, 'test.log'), testLog),
      writeFile(join(outputDir, 'pr-body.md'), delivery.prBody),
    ])

    let published: { url: string; number: number; isDraft: boolean } | undefined
    if (PUBLISH) {
      const repo = await repoFromEnv()
      if (!repo) {
        throw new Error(
          '--publish requires repository + GitHub App credentials (or GITHUB_TOKEN + ASCENDANT_ALLOW_GITHUB_TOKEN=1 locally).',
        )
      }
      const remote = repoClient(repo)
      const remoteFiles = await remote.readFiles(['src/session.ts', 'src/session.test.ts'])
      for (const path of ['src/session.ts', 'src/session.test.ts'] as const) {
        if (remoteFiles[path]?.trim() !== BASELINE[path].trim()) {
          throw new Error(`Refusing to publish: ${path} in the configured repo does not match the demo baseline.`)
        }
      }
      const pushed = await githubWriter(repo).openPr({
        branch: delivery.branch,
        baseSha: await remote.headSha(),
        base: repo.ref ?? 'main',
        commitMessage: delivery.commitMessage,
        files: Object.entries(applied.files)
          .filter(([path]) => path.startsWith('src/'))
          .map(([path, content]) => ({ path, content })),
        title: delivery.prTitle,
        body: delivery.prBody,
        draft: delivery.isDraft,
        labels: ['ascendant'],
      })
      published = { url: pushed.url, number: pushed.number, isDraft: pushed.isDraft }
      await updateTicket(db, ORG_ID, ticket.id, {
        status: 'done', branch: pushed.branch, prNumber: pushed.number, prUrl: pushed.url,
        prIsDraft: pushed.isDraft, closedAt: new Date(),
      })
      const slack = await notifySlack(slackFromEnv(), {
        text: delivery.slackSummary, prUrl: pushed.url, decisionId: decision.id, ts: ticket.slackTs,
      })
      const linear = await notifyLinear(linearFromEnv(), {
        issueId: ticket.linearId, stage: 'In Review', comment: `PR #${pushed.number}: ${pushed.url}`,
      })
      await trace(db, {
        orgId: ORG_ID, ticketId: ticket.id, runId: run.id, agent: 'delivery', phase: 'published',
        summary: `PR #${pushed.number} published; Slack ${slack.status}, Linear ${linear.status}.`,
        detail: { slack, linear, url: pushed.url },
      })
    } else {
      await updateTicket(db, ORG_ID, ticket.id, { status: 'delivering', branch: delivery.branch, prIsDraft: delivery.isDraft })
      await trace(db, {
        orgId: ORG_ID, ticketId: ticket.id, runId: run.id, agent: 'delivery', phase: 'preview_ready',
        summary: 'PR body, diff and passing test log are ready. External publication was not requested.',
        detail: { prBodyArtifactId: prBody.id, planArtifactId: planArtifact.id, diffArtifactId: diffArtifact.id, reviewArtifactId: reviewArtifact.id, testArtifactId: testArtifact.id },
      })
    }

    await finishRun(db, ORG_ID, run.id, 'succeeded', {
      tokensUsed: ctx.budget.usage.ticketTokens,
      llmCalls: ctx.budget.usage.ticketLlmCalls,
    })

    process.stdout.write(`\n✓ baseline tests: exit ${tests.baseline.exitCode}\n`)
    process.stdout.write(`✓ after tests:    exit ${tests.after.exitCode}\n`)
    process.stdout.write(`✓ QA verdict:     ${qaVerdict.verdict}\n`)
    process.stdout.write(`✓ artifacts:      ${outputDir}\n`)
    process.stdout.write(published ? `✓ PR:             ${published.url}\n` : `✓ delivery:       reviewable PR preview (use --publish after configuring the demo repo)\n`)
    process.stdout.write(`✓ run detail:     http://localhost:3000/events/${selected.eventId}\n\n`)
  } catch (err) {
    await persistTraces(db, run.id, ticket.id, ctx.traces)
    await updateTicket(db, ORG_ID, ticket.id, { status: 'blocked' })
    await finishRun(db, ORG_ID, run.id, 'failed', { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    await handle.close()
  }
}

function combine(result: { stdout: string; stderr: string; timedOut: boolean }): string {
  return [result.stdout, result.stderr, result.timedOut ? '[timed out]' : ''].filter(Boolean).join('\n').slice(0, 40_000)
}

main().catch((err) => {
  process.stderr.write(`\nDemo build failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
