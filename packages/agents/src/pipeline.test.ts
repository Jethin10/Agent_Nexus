import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { scanDiff } from '@ascendant/core'
import { code, orchestrate, plan, qa, research, review } from './pipeline.js'
import type { AgentContext, AgentTrace, CompleteFn } from './types.js'

/** A canned model response. No network, no provider, no router internals. */
function ctxWith(value: unknown, traces: AgentTrace[] = []): AgentContext {
  const complete = vi.fn(async (opts: { schema: z.ZodType<unknown> }) => ({
    value: opts.schema.parse(value),
    model: 'groq/llama-3.3-70b',
    tokens: 800,
    latencyMs: 1_000,
    attempts: [],
  })) as unknown as CompleteFn
  return { orgId: 'org_demo', complete, trace: (t) => void traces.push(t) }
}

const sentTo = (ctx: AgentContext) =>
  vi.mocked(ctx.complete).mock.calls[0]?.[0] as unknown as {
    task: string
    system: string
    messages: { role: string; content: string }[]
  }

function diffFor(path: string, added: string[], removed: string[] = []) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,3 +1,3 @@',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n')
}

const goodPlan = {
  verdict: 'plan',
  statement: 'Guard the expired-token path in the session helper and cover it with a test.',
  steps: [{ order: 1, path: 'src/session.ts', change: 'Return null when the token has expired.' }],
  filesTouched: ['src/session.ts'],
  risks: [{ risk: 'Callers may rely on the throw.', level: 'medium' }],
  testPlan: ['pnpm test src/session.test.ts'],
}

describe('orchestrate — agent 1, cheap tier', () => {
  it('sizes work and routes to the classify task class', async () => {
    const ctx = ctxWith({ complexity: 'standard', suggestedTokens: 20_000, reason: 'one file' })
    const res = await orchestrate(ctx, { title: 't', statement: 's' })
    expect(res.complexity).toBe('standard')
    expect(sentTo(ctx).task).toBe('classify')
  })
})

describe('research — agent 3', () => {
  it('returns a file map and traces what it found', async () => {
    const traces: AgentTrace[] = []
    const ctx = ctxWith(
      {
        summary: 'The session helper owns token expiry and has one existing test file.',
        files: [{ path: 'src/session.ts', why: 'owns getSessionId' }],
        priorArt: [{ ref: 'acme/api!88', relevance: 'previous fix in this area' }],
        openQuestions: [],
      },
      traces,
    )
    const res = await research(ctx, { title: 't', statement: 's', fileList: ['src/session.ts'] })
    expect(res.files[0]?.path).toBe('src/session.ts')
    expect(traces[0]).toMatchObject({ agent: 'research', phase: 'mapped' })
  })

  it('wraps the ticket as untrusted but passes the file list plainly', async () => {
    const ctx = ctxWith({ summary: 'x'.repeat(30), files: [], priorArt: [], openQuestions: [] })
    await research(ctx, { title: 'Crash', statement: 'Boom', fileList: ['src/a.ts', 'src/b.ts'] })
    const msg = sentTo(ctx).messages[0]?.content ?? ''
    expect(msg).toContain('<untrusted')
    expect(msg).toContain('src/a.ts')
  })
})

describe('plan — agent 4 refuses work outside its bounds', () => {
  it('returns a plan for well-scoped work', async () => {
    const ctx = ctxWith(goodPlan)
    const res = await plan(ctx, {
      title: 't',
      statement: 's',
      research: { summary: 'r', files: [] },
      files: [{ path: 'src/session.ts', content: 'export const x = 1' }],
    })
    expect(res.verdict).toBe('plan')
    expect(res.escalateReason).toBeUndefined()
  })

  it('escalates a plan spanning more files than the ceiling allows', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`)
    const ctx = ctxWith({
      ...goodPlan,
      // filesTouched is Zod-capped, so the overrun arrives via steps — which is
      // exactly the shape that would otherwise slip past validation.
      filesTouched: ['src/f0.ts'],
      steps: many.map((p, i) => ({ order: i + 1, path: p, change: 'change something here' })),
    })
    const res = await plan(ctx, {
      title: 't',
      statement: 's',
      research: { summary: 'r', files: [] },
      files: [],
    })
    expect(res.verdict).toBe('escalate')
    expect(res.escalateReason).toContain('file ceiling')
  })

  it('escalates a plan that intends to touch a protected path', async () => {
    const ctx = ctxWith({
      ...goodPlan,
      steps: [{ order: 1, path: '.github/workflows/ci.yml', change: 'add a step to the workflow' }],
      filesTouched: ['.github/workflows/ci.yml'],
    })
    const res = await plan(ctx, {
      title: 't',
      statement: 's',
      research: { summary: 'r', files: [] },
      files: [],
    })
    expect(res.verdict).toBe('escalate')
    expect(res.escalateReason).toContain('protected paths')
  })

  it('keeps the model’s own escalation reason', async () => {
    const ctx = ctxWith({
      ...goodPlan,
      verdict: 'escalate',
      escalateReason: 'This requires adding a dependency, which is a human decision.',
      steps: [],
      filesTouched: [],
    })
    const res = await plan(ctx, {
      title: 't',
      statement: 's',
      research: { summary: 'r', files: [] },
      files: [],
    })
    expect(res.escalateReason).toContain('adding a dependency')
  })

  it('passes the Reviewer’s objections back in on a revision round', async () => {
    const ctx = ctxWith(goodPlan)
    await plan(ctx, {
      title: 't',
      statement: 's',
      research: { summary: 'r', files: [] },
      files: [],
      round: 1,
      critique: {
        verdict: 'revise',
        summary: 'The plan misses the null path.',
        comments: [
          { path: 'src/session.ts', severity: 'major', comment: 'handle a null token too' },
        ],
      },
    })
    expect(sentTo(ctx).messages[0]?.content).toContain('handle a null token too')
  })
})

describe('code — agent 5 scans its own output', () => {
  it('returns a diff with a clean scan', async () => {
    const diff = diffFor('src/session.ts', ['  if (!token) return null'])
    const ctx = ctxWith({ diff, filesTouched: ['src/session.ts'], notes: '' })
    const res = await code(ctx, {
      title: 't',
      statement: 's',
      plan: goodPlan,
      files: [{ path: 'src/session.ts', content: 'x' }],
    })
    expect(res.scan.mustEscalate).toBe(false)
    expect(res.scan.parsed.files).toHaveLength(1)
  })

  it('flags its own diff when it deletes a test — §14.3', async () => {
    const diff = diffFor('src/a.test.ts', [], ['it("works", () => expect(1).toBe(1))'])
    const traces: AgentTrace[] = []
    const ctx = ctxWith({ diff, filesTouched: ['src/a.test.ts'], notes: '' }, traces)
    const res = await code(ctx, {
      title: 't',
      statement: 's',
      plan: goodPlan,
      files: [],
    })
    expect(res.scan.mustEscalate).toBe(true)
    expect(res.scan.findings.map((f) => f.rule)).toContain('test-erosion')
    expect(traces[0]?.summary).toContain('BLOCKED')
  })

  it('feeds QA failures back in without inviting a deletion', async () => {
    const ctx = ctxWith({ diff: diffFor('src/a.ts', ['fixed']), filesTouched: ['src/a.ts'], notes: '' })
    await code(ctx, {
      title: 't',
      statement: 's',
      plan: goodPlan,
      files: [],
      failures: [{ test: 'handles expiry', message: 'expected null', rootCauseGuess: 'missing guard' }],
    })
    const msg = sentTo(ctx).messages[0]?.content ?? ''
    expect(msg).toContain('handles expiry')
    expect(msg).toContain('without deleting or weakening them')
  })
})

describe('review — agent 6 is floored by the deterministic scan', () => {
  it('passes a clean diff through on the model’s verdict', async () => {
    const diff = diffFor('src/session.ts', ['  if (!token) return null'])
    const ctx = ctxWith({ verdict: 'approve', summary: 'Looks correct.', comments: [] })
    const res = await review(ctx, { plan: goodPlan, diff, scan: scanDiff(diff) })
    expect(res.verdict).toBe('approve')
  })

  it('overrides an approve when the scan found a blocker', async () => {
    // The model can be wrong or fooled; the scan cannot be argued with.
    const diff = diffFor('src/a.ts', ['eval(userInput)'])
    const traces: AgentTrace[] = []
    const ctx = ctxWith({ verdict: 'approve', summary: 'Fine by me.', comments: [] }, traces)
    const res = await review(ctx, { plan: goodPlan, diff, scan: scanDiff(diff) })

    expect(res.verdict).toBe('reject')
    expect(res.comments.some((c) => c.rule === 'eval')).toBe(true)
    expect(traces[0]?.summary).toContain('overridden by the deterministic scan')
  })

  it('hands the findings in as proven, so the model does not re-litigate them', async () => {
    const diff = diffFor('src/a.ts', ['eval(x)'])
    const ctx = ctxWith({ verdict: 'reject', summary: 'This diff is unsafe.', comments: [] })
    await review(ctx, { plan: goodPlan, diff, scan: scanDiff(diff) })
    expect(sentTo(ctx).messages[0]?.content).toContain('already proven — do not re-litigate')
  })

  it('records rule ids so repeated objections are minable', async () => {
    const diff = diffFor('src/a.ts', ['const x = 1'])
    const traces: AgentTrace[] = []
    const ctx = ctxWith(
      {
        verdict: 'revise',
        summary: 'Needs an error path.',
        comments: [
          { path: 'src/a.ts', severity: 'major', comment: 'no error path', rule: 'missing-error-path' },
        ],
      },
      traces,
    )
    await review(ctx, { plan: goodPlan, diff, scan: scanDiff(diff) })
    expect(traces[0]?.detail?.rules).toContain('missing-error-path')
  })
})

describe('qa — agent 7 excludes the pre-existing baseline', () => {
  it('reports a pass and traces both exit codes', async () => {
    const traces: AgentTrace[] = []
    const ctx = ctxWith({ verdict: 'pass', failures: [], flaky: [], summary: 'all green' }, traces)
    const res = await qa(ctx, {
      diff: 'd',
      baseline: { exitCode: 0, output: 'ok' },
      after: { exitCode: 0, output: 'ok' },
    })
    expect(res.verdict).toBe('pass')
    expect(traces[0]?.summary).toContain('baseline exit 0')
  })

  it('shows the model the baseline so it can discount pre-existing failures', async () => {
    const ctx = ctxWith({ verdict: 'pass', failures: [], flaky: [], summary: 's' })
    await qa(ctx, {
      diff: 'd',
      baseline: { exitCode: 1, output: 'FAIL unrelated.test.ts' },
      after: { exitCode: 1, output: 'FAIL unrelated.test.ts' },
    })
    const msg = sentTo(ctx).messages[0]?.content ?? ''
    expect(msg).toContain('BASELINE, BEFORE THE DIFF (exit 1)')
    expect(msg).toContain('AFTER THE DIFF (exit 1)')
  })

  it('passes re-runs through for flake detection', async () => {
    const ctx = ctxWith({ verdict: 'pass', failures: [], flaky: ['flaky one'], summary: 's' })
    const res = await qa(ctx, {
      diff: 'd',
      baseline: { exitCode: 0, output: 'ok' },
      after: { exitCode: 1, output: 'FAIL flaky one' },
      reruns: [
        { exitCode: 0, output: 'ok' },
        { exitCode: 0, output: 'ok' },
      ],
    })
    expect(sentTo(ctx).messages[0]?.content).toContain('RE-RUNS')
    expect(res.flaky).toEqual(['flaky one'])
  })

  it('distinguishes inconclusive from failing', async () => {
    const ctx = ctxWith({
      verdict: 'inconclusive',
      failures: [],
      flaky: [],
      summary: 'the suite could not start',
    })
    const res = await qa(ctx, {
      diff: 'd',
      baseline: { exitCode: 127, output: 'command not found' },
      after: { exitCode: 127, output: 'command not found' },
    })
    expect(res.verdict).toBe('inconclusive')
  })
})
