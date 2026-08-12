import type { z } from 'zod'
import type { CompleteFn } from '@ascendant/agents'

/**
 * A `CompleteFn` that returns hand-authored model output instead of calling a
 * provider, so the pipeline can run end to end with no credentials at all.
 *
 * This exists because §16.3 requires the demo to survive with no network, and
 * because `GROQ_API_KEY` is the one thing a reader of this repo cannot be assumed to
 * have. It is a **fixture, not inference**, and the whole design here is about making
 * that impossible to forget:
 *
 * - every response is labelled `fixture:<task>`, which lands in `agent_events.model`
 *   and `decisions.model_used`, so the dashboard shows the provenance of every row
 * - the returned text is validated through the caller's own Zod schema, so a fixture
 *   that drifts out of shape fails exactly as a bad model response would
 * - only the model's *text* is canned. Citation validation, the server-side
 *   confidence recomputation, banding and the ESCALATE overrides all run for real
 *
 * That last point is what makes this worth having rather than a mock: a fixture that
 * cites a ref the retrieval layer never returned is still forced to ESCALATE by
 * `validateCitations`, because the machinery around the model is the actual product.
 */

export interface OfflineModelOptions {
  /** Fixed latency reported per call, so a replay has plausible timings. */
  latencyMs?: number
  /** Called for every request, for the runner's verbose output. */
  onCall?: (task: string, model: string) => void
}

/** Refs the CANDIDATES block actually contained, in the order they appear. */
function refsInPrompt(text: string): string[] {
  const refs: string[] = []
  // candidateLine() renders each candidate as `[n] ref=<ref> kind=… via=…`, so
  // anchoring on `ref=` keeps a fixture honest: it can only cite evidence that
  // retrieval really returned, and validateCitations checks that independently.
  for (const m of text.matchAll(/\bref=(\S+)/g)) {
    const ref = m[1]
    if (ref && !refs.includes(ref)) refs.push(ref)
  }
  return refs
}

function firstRefMatching(text: string, pattern: RegExp): string | undefined {
  return refsInPrompt(text).find((r) => pattern.test(r))
}

/**
 * Just the event under triage, without the candidate block.
 *
 * Load-bearing: the seeded corpus contains prior decisions and docs that mention
 * GraphQL, duplicates and performance, so matching intent against the whole prompt
 * makes every scenario look like every other one — the first branch wins for all of
 * them. A real model distinguishes "the thing I am judging" from "the evidence I was
 * given" because the prompt labels them; this does the same.
 */
function eventSection(prompt: string): string {
  const start = prompt.indexOf('## THE EVENT UNDER TRIAGE')
  if (start === -1) return prompt
  const end = prompt.indexOf('## CANDIDATES', start)
  return end === -1 ? prompt.slice(start) : prompt.slice(start, end)
}

/**
 * Whether a Zod object schema declares a given key.
 *
 * Used to tell two agents apart when they share a task class. Reaching into
 * `_def.shape()` is Zod-internal, so it is guarded: an unrecognised schema shape
 * returns false rather than throwing, and the caller falls back to the other fixture.
 */
function schemaHasKey(schema: unknown, key: string): boolean {
  try {
    const def = (schema as { _def?: { shape?: () => Record<string, unknown> } })._def
    const shape = typeof def?.shape === 'function' ? def.shape() : undefined
    return Boolean(shape && key in shape)
  } catch {
    return false
  }
}

/**
 * The triage fixture. Reads the prompt the same way a model would — the event
 * metadata and the candidate block are both in there — and picks the outcome the
 * seeded scenario is designed to produce.
 *
 * Deliberately keyed on the *content* rather than on a scenario id passed in
 * out-of-band: the fixture has access to exactly what a model would have, so a
 * scenario that stops working because retrieval regressed will visibly stop working
 * here too rather than passing on a hardcoded answer.
 */
function triageFixture(prompt: string): Record<string, unknown> {
  /**
   * Intent is read from the event alone; refs are resolved against the whole prompt
   * (which is where the candidate block lives). Mixing the two makes every scenario
   * match the first branch, because the seeded corpus discusses all of these topics.
   */
  const event = eventSection(prompt)
  const lower = event.toLowerCase()
  const refs = refsInPrompt(prompt)

  // 1. Contradicts a documented architecture decision → REJECT.
  //    The most impressive single behaviour in the system (§14.2).
  if (/graphql/i.test(event)) {
    /**
     * Must cite the ADR specifically, not merely something that mentions GraphQL.
     * The seeded corpus contains a PRD and a meeting note that both discuss the same
     * topic, and citing either would attach the ADR's verbatim quote to a document
     * that does not contain it — a fabricated citation that happens to name a real
     * ref. Ordered patterns, most specific first, rather than one loose alternation.
     */
    const doc =
      firstRefMatching(prompt, /adr-\d+|adr[-_]?0*7/i) ??
      firstRefMatching(prompt, /arch.*review|granola/i)
    if (doc) {
      const quote = /adr/i.test(doc)
        ? 'we are not adding a GraphQL layer, decided 2026-06-12'
        : 'Decision: no GraphQL layer. Recorded as ADR-0007.'
      return {
        outcome: 'REJECT',
        confidence: 0.91,
        reasoning:
          'This requests a GraphQL endpoint, which contradicts a documented architecture ' +
          'decision. The decision doc records that no GraphQL layer will be added, with a ' +
          'date and a rationale, and nothing in this request argues against that reasoning ' +
          'or presents new information. Building it would contradict a deliberate choice, so ' +
          'the honest answer is to decline and point at the decision rather than quietly ' +
          'implement something the team already ruled out.',
        citations: [
          {
            kind: 'doc',
            ref: doc,
            quote,
            why: 'The architecture decision this request contradicts, with its date.',
          },
        ],
      }
    }
  }

  // 2. Already fixed on main → REJECT, citing the merged PR. Retrieval source #3.
  if (/already|still (seeing|happening)|regress/i.test(lower)) {
    const pr = firstRefMatching(prompt, /!\d+/)
    if (pr) {
      return {
        outcome: 'REJECT',
        confidence: 0.84,
        reasoning:
          'This failure was already fixed on main. A merged pull request touches the exact ' +
          'file in the reported stack frame and describes the same null-guard problem. The ' +
          'report is honest and the bug was real, but the work is done, so opening a ticket ' +
          'would duplicate effort that has already shipped. If the failure persists on a ' +
          'build that includes that change, this should be reopened as a regression.',
        citations: [
          {
            kind: 'pr',
            ref: pr,
            quote: 'Fix session id crash on expired token',
            why: 'Merged change touching the same file as the reported stack frame.',
          },
        ],
      }
    }
  }

  /**
   * 3. A reworded duplicate → MERGE. Requires a target by schema (D7).
   *
   * Deliberately narrow. An error string alone is not duplication: the seeded ACCEPT
   * scenario reports the *same* TypeError from the *same* file but for a different
   * trigger (an unknown token rather than an expired one), and merging those would
   * bury a real bug under a closed one. That is the expensive mistake in triage, so
   * the match requires the duplicate's own vocabulary — an expiry/timeout trigger —
   * rather than just a shared exception.
   */
  const looksLikeDuplicate =
    /duplicate|same (error|failure|crash)/i.test(lower) ||
    (/typeerror/i.test(lower) && /expire|timed out|timeout/i.test(lower))
  const describesDifferentTrigger = /unknown token|not (in|present in) the store|absent/i.test(lower)

  if (looksLikeDuplicate && !describesDifferentTrigger) {
    const target = firstRefMatching(prompt, /#\d+/)
    if (target) {
      return {
        outcome: 'MERGE',
        confidence: 0.88,
        reasoning:
          'This is the same failure as an existing open issue, described in different words. ' +
          'Both report an identical error string originating in the same file and line, and ' +
          'both began after the same release. Linking them keeps the discussion and any fix ' +
          'in one place instead of splitting the investigation across two threads.',
        citations: [
          {
            kind: 'issue',
            ref: target,
            quote: "TypeError: cannot read 'id' of undefined",
            why: 'Identical error string and origin as the existing open issue.',
          },
        ],
        mergeTargetId: target,
      }
    }
  }

  // 4. Not enough information to act → DEFER with specific questions (D7).
  //    The length bound is on the event, not the prompt: a short report stays short
  //    regardless of how much evidence retrieval attached to it.
  if (/(doesn'?t|does not) work|broken|please fix|help/i.test(lower) && event.length < 1_400) {
    const any = refs[0]
    if (any) {
      return {
        outcome: 'DEFER',
        confidence: 0.72,
        reasoning:
          'There is not enough here to act on. The report states that something is broken ' +
          'but gives no reproduction steps, no error output and no indication of which ' +
          'version or environment it occurred in. Rather than guessing at the problem or ' +
          'closing a possibly real bug, this asks the filer three specific questions and ' +
          'waits. A concrete answer to any of them would make this actionable.',
        citations: [
          {
            kind: 'issue',
            ref: any,
            quote: 'similar reports that were actionable once repro steps were added',
            why: 'Comparable issues show what detail makes this class of report tractable.',
          },
        ],
        missingInfo: [
          'What are the exact steps to reproduce this?',
          'What error message or stack trace do you see, verbatim?',
          'Which version and environment did this happen on?',
        ],
      }
    }
  }

  // 5. Ambiguous and consequential → ESCALATE rather than guess.
  if (/slow|performance|latency|sometimes|intermittent/i.test(lower)) {
    const any = refs[0]
    if (any) {
      return {
        outcome: 'ESCALATE',
        confidence: 0.46,
        reasoning:
          'This describes a performance complaint without a measurement, and the retrieved ' +
          'evidence does not clearly match or rule it out. It could be a real regression, an ' +
          'environmental problem, or expected behaviour under load, and those have very ' +
          'different responses. Confidence is below the autonomy band, so this goes to a ' +
          'human with the retrieved context attached rather than being acted on.',
        citations: [
          {
            kind: 'issue',
            ref: any,
            quote: 'related but not conclusive prior report',
            why: 'Closest retrieved evidence; similar in area but not the same failure.',
          },
        ],
      }
    }
  }

  // Default: a real, actionable, well-specified bug → ACCEPT. The only path to code.
  const any = refs[0]
  return {
    outcome: 'ACCEPT',
    confidence: 0.86,
    reasoning:
      'This is a real, actionable and well-specified bug. It names the failing behaviour, ' +
      'includes the error and the file it originates in, and nothing in the retrieved ' +
      'evidence suggests it is a duplicate or already fixed. The affected area has test ' +
      'coverage, so a change here can be verified rather than assumed. This is worth an ' +
      'engineer-equivalent of work, so it opens a ticket and enters the build pipeline.',
    citations: any
      ? [
          {
            kind: 'issue',
            ref: any,
            quote: 'nearest retrieved neighbour, reviewed and ruled out as a duplicate',
            why: 'Checked against the closest prior work before accepting as new.',
          },
        ]
      : [
          {
            kind: 'doc',
            ref: 'policy:no_candidates',
            quote: 'no comparable prior work was retrieved for this event',
            why: 'Recorded so an ACCEPT with no neighbours is auditable rather than silent.',
          },
        ],
  }
}

/** Research (agent 3) — a plausible repo map for the seeded demo repo. */
function researchFixture(): Record<string, unknown> {
  return {
    summary:
      'The session id crash originates in the token-expiry path: the session lookup can ' +
      'return undefined when a token has expired, and the caller dereferences it without a ' +
      'guard. The affected module has direct unit-test coverage, so a fix is verifiable.',
    files: [
      { path: 'src/session.ts', why: 'Contains the unguarded dereference in the stack frame.' },
      { path: 'src/session.test.ts', why: 'Existing coverage for this module; extend it here.' },
    ],
    priorArt: [],
    openQuestions: [],
  }
}

/** Planner (agent 4) — a bounded plan well inside MAX_FILES_TOUCHED. */
function planFixture(): Record<string, unknown> {
  return {
    verdict: 'plan',
    statement:
      'Guard the expired-token branch in getSessionId so it returns null instead of ' +
      'dereferencing an undefined session, and cover the expired case with a test.',
    steps: [
      {
        order: 1,
        path: 'src/session.ts',
        change: 'Return null when the session lookup yields undefined, before reading .id.',
      },
      {
        order: 2,
        path: 'src/session.test.ts',
        change: 'Add a case asserting an expired token yields null rather than throwing.',
      },
    ],
    filesTouched: ['src/session.ts', 'src/session.test.ts'],
    risks: [
      {
        risk: 'Callers that relied on the throw to detect expiry would now receive null.',
        level: 'low',
      },
    ],
    testPlan: ['pnpm test — the expired-token case must fail before the fix and pass after.'],
  }
}

/**
 * Coder (agent 5) — a real unified diff.
 *
 * Written as a genuine patch rather than a placeholder because `applyDiff` parses it
 * for real, `scanDiff` inspects it for blockers, and `detectTestErosion` counts its
 * assertions. A fake diff would fail those checks, which is the point: the machinery
 * around the model is not stubbed.
 */
function codeFixture(): Record<string, unknown> {
  return {
    diff: `diff --git a/src/session.ts b/src/session.ts
--- a/src/session.ts
+++ b/src/session.ts
@@ -1,8 +1,12 @@
 export interface Session {
   id: string
   expiresAt: number
 }

 export function getSessionId(store: Map<string, Session>, token: string): string | null {
   const session = store.get(token)
+  if (!session) return null
+  if (session.expiresAt <= Date.now()) return null
   return session.id
 }
diff --git a/src/session.test.ts b/src/session.test.ts
--- a/src/session.test.ts
+++ b/src/session.test.ts
@@ -1,10 +1,20 @@
 import { describe, expect, it } from 'vitest'
 import { getSessionId } from './session'

 describe('getSessionId', () => {
   it('returns the id for a live session', () => {
     const store = new Map([['t1', { id: 's1', expiresAt: Date.now() + 60_000 }]])
     expect(getSessionId(store, 't1')).toBe('s1')
   })
+
+  it('returns null for an expired session rather than throwing', () => {
+    const store = new Map([['t2', { id: 's2', expiresAt: Date.now() - 1 }]])
+    expect(getSessionId(store, 't2')).toBeNull()
+  })
+
+  it('returns null for an unknown token', () => {
+    expect(getSessionId(new Map(), 'nope')).toBeNull()
+  })
 })
`,
    filesTouched: ['src/session.ts', 'src/session.test.ts'],
    notes:
      'Added the null guard the Reviewer asked for and covered both the expired and the ' +
      'unknown-token paths, so the change is verified rather than asserted.',
  }
}

/** Reviewer (agent 6). Approves; `scanDiff` can still floor this to reject. */
function reviewFixture(): Record<string, unknown> {
  return {
    verdict: 'approve',
    summary:
      'The guard is in the right place and both failure modes are covered by new assertions. ' +
      'No test was weakened and the change is confined to the two planned files.',
    comments: [
      {
        path: 'src/session.ts',
        line: 8,
        severity: 'nit',
        comment: 'Returning null for both unknown and expired tokens is fine here, but the ' +
          'caller cannot distinguish them. Worth a comment if that matters later.',
        rule: 'prefer-explicit-error-cases',
      },
    ],
  }
}

/** QA (agent 7). Reads a sandbox result — it never runs anything itself (R1). */
function qaFixture(prompt: string): Record<string, unknown> {
  const failed = /exit(_| )?code:?\s*[1-9]/i.test(prompt) || /FAIL|failing/.test(prompt)
  if (failed) {
    return {
      verdict: 'fail',
      failures: [
        {
          test: 'getSessionId > returns null for an expired session rather than throwing',
          message: 'Expected null, received undefined.',
          rootCauseGuess:
            'The guard returns before the expiry check, so an expired-but-present session ' +
            'falls through to the original dereference.',
        },
      ],
      flaky: [],
      summary: 'The new expiry case fails; the baseline suite was green, so this is the diff.',
    }
  }
  return {
    verdict: 'pass',
    failures: [],
    flaky: [],
    summary:
      'Baseline was green and remains green with the diff applied; the two new assertions ' +
      'both pass, so the reported crash is covered.',
  }
}

/** Orchestrator (agent 1) — cheap routing, not reasoning. */
function routingFixture(): Record<string, unknown> {
  return {
    complexity: 'standard',
    suggestedTokens: 40_000,
    reason: 'Single-module bug with existing test coverage; no dependency or API change.',
  }
}

/**
 * Builds the fixture `CompleteFn`.
 *
 * The returned function satisfies the same contract as the router's `complete()`, so
 * it drops into `AgentContext.complete` and no agent can tell the difference — which
 * is exactly R1 paying off: the seam already existed for tests.
 */
export function offlineComplete(opts: OfflineModelOptions = {}): CompleteFn {
  const latencyMs = opts.latencyMs ?? 240

  return async <T>(o: {
    task: string
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
    system: string
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
    maxTokens?: number
    temperature?: number
  }) => {
    const prompt = o.messages.map((m) => m.content).join('\n\n')
    const model = `fixture:${o.task}`

    let raw: Record<string, unknown>
    switch (o.task) {
      case 'triage':
        raw = triageFixture(prompt)
        break
      case 'plan':
        /**
         * Research and Planner share the `plan` task class (pipeline.ts:92 and
         * :152), so the task alone cannot disambiguate them. The schema can: only
         * ResearchOutput has `files`. Keyed on the caller's actual schema rather
         * than on prompt text, which would break the moment a prompt is reworded.
         */
        raw = schemaHasKey(o.schema, 'files') ? researchFixture() : planFixture()
        break
      case 'code':
        raw = codeFixture()
        break
      case 'review':
        raw = reviewFixture()
        break
      case 'qa':
        raw = qaFixture(prompt)
        break
      case 'classify':
        raw = routingFixture()
        break
      case 'summarize':
        raw = researchFixture()
        break
      default:
        throw new Error(`offlineComplete: no fixture for task '${o.task}'`)
    }

    /**
     * Validated through the caller's own schema, not returned blind. A drifted
     * fixture fails here exactly as a bad model response would, rather than
     * producing a decision that only looks well-formed.
     */
    const parsed = o.schema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `offlineComplete: fixture for '${o.task}' does not satisfy the caller's schema:\n${parsed.error.issues
          .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('\n')}`,
      )
    }

    opts.onCall?.(o.task, model)

    return {
      value: parsed.data,
      model,
      // A fixture consumed no quota. Reporting real usage would corrupt the
      // budget accounting the dashboard displays.
      tokens: 0,
      latencyMs,
      attempts: [{ model, outcome: 'ok' as const, latencyMs }],
    }
  }
}
