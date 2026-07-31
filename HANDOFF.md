# HANDOFF

Living status doc for Ascendant. Read this first, before `PLAN.md`.

**Maintenance rule:** update this file whenever a §17 step completes, a decision is
made that a future agent could accidentally revert, or a blocker opens or closes.
Append to the Decisions log — never rewrite history there. Keep the Status board
and Next step accurate; everything else is reference.

Last updated: 2026-07-31 · after §17 steps 2-5

---

## 1. What this is

Hackathon submission, Track 07 (Open Innovation), judged on originality,
feasibility, real-world impact.

Every coding agent on the market (Devin, OpenHands, Copilot Workspace, Factory,
Codegen, Sweep, Charlie) starts at *"implement this,"* assuming the ticket is
valid. Ascendant's differentiator is the **Triage Gate**: it decides *whether*
work should be done before building any of it.

> Decides what to build. Then builds it.

Five triage outcomes, never binary: `ACCEPT`, `REJECT`, `MERGE`, `DEFER`,
`ESCALATE`. **Four of the five are refusals — that is the product.** Every
decision carries reasoning plus at least one citation.

Six layers: Event Sources → Normalizer → **TRIAGE GATE** → Work Pipeline →
Delivery → Learning Loop.

The one reported number: `triage precision = 1 − (overturns / autonomous_decisions)`
over a 60-event hand-labelled eval set, reported as a **confusion matrix over the
five outcomes** — not a scalar, because a false REJECT (work silently dropped) is
far worse than a false ACCEPT (wasted tokens, human notices the PR).

Everything runs on free tiers. All TypeScript. `PLAN.md` (1118 lines) is the full
spec and is authoritative; section refs below (§5.4, §17, etc.) point into it.

---

## 2. Status board (§17 build order)

Nothing is cut, only sequenced. Steps 1-3 alone are a defensible submission;
1-6 a strong one; all ten is the plan.

| # | Step | State |
|---|---|---|
| 1 | db schema + Normalizer + GitHub connector | **done** |
| 2 | Triage Gate + retrieval + decision object | **done** |
| 3 | Dashboard Inbox + Run Detail | **done** (Inbox, Run Detail, Metrics, Policy) |
| 4 | Inngest workflows + LLM router | **done** (6 functions, router, budget) |
| 5 | Planner/Coder/Reviewer/QA + E2B sandbox | **done** (8 agents, 3 drivers) |
| 6 | Delivery: PR + Linear + Slack | GitHub PR **done**; Linear/Slack todo |
| 7 | Remaining connectors (Linear/Gmail/GCal/Drive/Granola) | todo |
| 8 | Learning loop + eval set + metrics | queries + views **done**; `pnpm eval` todo |
| 9 | Security layers 1-4 hardening | all 4 layers **done**; no dashboard auth |
| 10 | Seed fixtures + recorded demo + offline fallbacks | **next** |

Verification state right now: `pnpm -r typecheck` clean across all 8 workspace
projects, `pnpm test` = **309 passing**, and `next build` compiles all 7 routes.

| suite | tests |
|---|---|
| core: extract / normalize / policy / confidence / candidates / prompt / diff | 10 / 22 / 24 / 20 / 17 / 19 / 29 |
| connectors: github | 22 |
| router: cascade, repair, budget, guard | 34 |
| agents: triage / pipeline / delivery | 18 / 19 / 26 |
| sandbox: guards + local driver | 33 |
| workflows: applyDiff + repo client | 16 |

---

## 3. Next step, concretely

**§17 step 10 — seed fixtures, then the eval set (step 8).** The pipeline is
built end to end and nothing has ever run against a live database or a real key.
Everything below this line is written and tested; nothing below it is *proven*.

Do these in order, because each unblocks the next:

1. **Provision Neon** (B1) and `pnpm db:push`. Nothing else can be verified until
   a real Postgres exists — the four retrieval queries in
   `db/queries/retrieval.ts` have never executed.
2. **`scripts/seed-demo.ts`** (§16.1): ~40 historical issues, 12 merged PRs, 3
   design docs, 2 meeting notes, and the one architecture decision doc saying
   *"we are not adding a GraphQL layer, decided 2026-06-12."* That document is
   the setup for the best moment in the demo, so it is not optional colour.
   Embeddings need a Gemini key; without one, sources 1 and 4 return `[]` and
   `degraded` says so.
3. **Get a Groq key** (B2) and run one real event end to end. The triage agent's
   model call has only ever been exercised through a canned `complete()`.
4. **`scripts/eval.ts`** (step 8, §11.2): 60 hand-labelled real GitHub issues →
   confusion matrix → `evals/results-<date>.json`. `triagePrecision()` and the
   `Matrix` component already read it; the labelled set itself does not exist.
   **Run this the night before, not the morning of** — ~1,500 Groq requests
   against a 1,000 RPD ceiling.
5. **Steps 6-7**: Linear and Slack delivery, then the remaining connectors. The
   GitHub half of delivery is done (`workflows/github-write.ts`).

### The wiring, end to end

```
webhook → apps/web/api/webhooks/github  verify → guard → normalize → insert → emit
        → ingest        confirms the row, emits triage/requested
        → triage        decide() → retrieveCandidates() → triage() → insertDecision()
                        ACCEPT only: openTicketForAccept() → work/accepted
        → plan-and-code research → plan ⇄ review → code ⇄ review → review/ready
        → qa            runTests() in a sandbox → qa() reads it → delivery/ready
        → deliver       deliver() templates the PR → githubWriter.openPr()
```

`maintenanceFn` is the sixth function: one 05:00 UTC cron (§7.2).

### What steps 2-5 actually built

- `core/policy.ts` — six rules as pure functions, `decide()` returns the decisive
  hit. A decisive hit means **the LLM is never called** (`cost.tokens === 0`).
- `core/confidence.ts` — the §5.4 weighted sum, `band()` is the single place the
  autonomy/injection/trust ceilings are interpreted.
- `core/candidates.ts` — `mergeCandidates()` (union/dedupe/rank/cap),
  `bestSimilarity()`, and `validateCitations()`.
- `core/prompt.ts` — `TRIAGE_SYSTEM` plus `untrustedBlock()`/`candidateBlock()`.
- `core/diff.ts` — `parseDiff`, `detectTestErosion`, `scanDiff`. §15.3 layer 4 and
  the §14.3 hard rule, all deterministic.
- `db/queries/*` — retrieval (4 sources), policy context, events, decisions,
  trace, metrics.
- `router/*` — cascade, rung scoring, schema repair, budget, injection guard.
- `agents/` — `triage.ts` (the gate), `pipeline.ts` (orchestrator, research,
  plan, code, review, qa), `delivery.ts` (agent 8, **no model call at all**).
- `sandbox/` — `guards.ts` shared by three drivers: `e2b` primary, `actions`
  fallback, `local` for the offline demo path.
- `workflows/` — six Inngest functions, `repo.ts` (+ `applyDiff`),
  `github-write.ts` (the push, outside the sandbox).
- `apps/web/` — Inbox, Run Detail, Metrics, Policy, plus `/api/inngest` and
  `/api/webhooks/github`.

Non-obvious behaviour a caller must know:

1. **Citations are verified, not trusted.** Zod enforces that citations *exist*;
   `validateCitations` enforces they are *real*. A fabricated ref forces
   ESCALATE (`bandApplied: ['fabricated_citation']`). Zod alone cannot catch this
   — `acme/api#412` is a well-formed string.
2. **A refusal with zero candidates is impossible.** REJECT/MERGE with an empty
   candidate set is rewritten to ESCALATE (`refusal_without_evidence`).
3. **`band()` is the only interpreter of the bands.** Never compare a confidence
   to a threshold at a call site.
4. **`needsReview` is false for ESCALATE** — it is already in a human's queue;
   flagging it again would double-count it in the Inbox.
5. **Retrieval degrades, never throws.** A failing source returns `[]` and is
   named in `degraded`. Less evidence → lower `evidenceStrength` → lower
   confidence → routed to a human. That is the correct failure mode.
6. **`openTicketForAccept` throws on a non-ACCEPT decision.** The gate being the
   only door into the pipeline is enforced there, not by convention at call sites.
7. **The Reviewer's verdict is floored by `scanDiff`.** An `approve` on a diff
   carrying a blocker is rewritten to `reject` and the findings are appended as
   Reviewer comments. The model sees the scan results as *already proven* input so
   it does not re-litigate them.
8. **A red QA run does not loop forever.** `MAX_CODER_RETRIES` is enforced inside
   the round-2 loop, so the `review/ready` → `delivery/ready` path cannot
   ping-pong.
9. **`deliver()` makes no model call.** The PR body's `Why` section is the triage
   reasoning verbatim — it is the audit trail, and a model would paraphrase it.
10. **A sandbox handle cannot cross a `step.run` boundary.** Inngest serializes
    step returns and a live microVM is not serializable, so create → write →
    install → baseline → run → destroy is one step.
11. **`applyDiff` fails loudly rather than fuzzily patching.** A hunk whose
    context does not match returns the path in `failed` and leaves the file
    untouched; §14.3 makes that a rebase-then-ESCALATE, not a best-effort apply.

Original step-2 build notes, kept because they are still the spec:

1. **Six deterministic pre-LLM policy rules** (§5.3), pure functions over a
   `NormalizedEvent`, no LLM, no network. Every rule that fires lands in
   `policyHits` on the decision row:
   | rule | outcome |
   |---|---|
   | `exact_dupe` (contentHash match) | MERGE |
   | `bot_author` | REJECT |
   | `empty_body` | DEFER |
   | `template_unfilled` | DEFER |
   | `already_closed_ref` | ESCALATE |
   | `spam_signature` | REJECT |
2. **Retrieval, 4 sources** (§9) — union, dedupe, cap 20 candidates, ~6k token
   budget: (a) vector neighbours, top-8 cosine via pgvector; (b) lexical
   neighbours, top-8 Postgres `ts_rank`; (c) recent git activity, last 21 days,
   overlapping extracted symbols — this is what powers *"already fixed on main"*;
   (d) **decision memory** — prior `decisions` rows within cosine 0.15, so a
   re-filed rejected issue is rejected consistently and cites its own prior
   rejection.
3. **Confidence** (§5.4). All three components are stored per-decision
   (`modelSelfReport`, `evidenceStrength`, `policyAgreement` columns already
   exist) so calibration is auditable after the fact:
   ```
   confidence = 0.5 * model_self_report
              + 0.3 * evidence_strength    // best citation similarity, calibrated
              + 0.2 * policy_agreement     // do the deterministic rules concur?
   ```
   Bands: ≥0.80 act autonomously; 0.55-0.79 act but set `needsReview`; <0.55
   ESCALATE. Read thresholds from the `config` table, **not** from the
   `CONFIDENCE` constants — the constants are only defaults. The demo drags this
   threshold live (§16 beat 4), so a hardcoded read breaks the demo.

All of step 2 was built and tested with **zero credentials**: the four retrieval
queries are written but unexercised against a live Neon instance (B1), and the
triage agent's model call is exercised only through a canned `complete()` in
`triage.test.ts`. Both still need a real key to be confirmed end to end.

---

## 4. What exists on disk

```
PLAN.md                     authoritative spec, 1118 lines
HANDOFF.md                  this file
context/Rough_idea.md       original concept. 391KB — the two long lines are
                            base64 architecture diagrams; Read with limit: 9
tsconfig.base.json          strict, noUncheckedIndexedAccess,
                            verbatimModuleSyntax, moduleResolution: Bundler
pnpm-workspace.yaml         apps/* + packages/*
.env.example                names only, never values
packages/core/              13 src files — pure, no I/O, no network
packages/db/                22 src files + migrations/
packages/connectors/        5 src files
packages/router/            6 src files — the only place a provider is named
packages/agents/            7 src files — pure fns, `complete` injected (R1)
packages/sandbox/           6 src files — 3 drivers behind one interface
packages/workflows/         11 src files — the ONLY layer that does I/O
apps/web/                   Next 15 App Router, 4 views + 2 API routes
```

`scripts/` does not exist yet — `seed-demo.ts` and `eval.ts` are the next step.

### packages/core
Every file here is a pure function or a Zod schema. No I/O anywhere, by design:
this is what makes all seven agents unit-testable with no network and the whole
pipeline replayable from stored rows.

- `ids.ts` — `OrgId`, `SourceId` (7 sources), `EventKind` (8 kinds), `TrustLevel`
- `limits.ts` — `LIMITS`, `CONFIDENCE`, `BLOCKED_WRITE_PATTERNS` + `isBlockedPath()`
- `event.ts` — `RawEvent`, `Extracted`, `NormalizedEvent`
- `extract.ts` — deterministic regex extraction, no LLM
- `normalize.ts` — `stripQuoted`, `contentHash`, `deriveTrust`, `unitKey`, `normalize`
- `triage.ts` — `TriageOutcome`, `Citation`, `TriageDecision`, `TriageDecisionDraft`
- `index.ts` — barrel

Behaviour a caller must know:
- `extract()` matches **file paths over the whole text**, but dotted calls and
  camelCase/snake_case identifiers **only inside code spans** (fenced blocks and
  inline backticks). Prose mentioning `auth.getSessionId(token)` is deliberately
  ignored, so the join keys stay clean.
- SHA candidates must contain both a hex letter and a digit, so `1234567` and
  `deadbee` are rejected.
- Every `Extracted` field is deduped and capped at 40.
- `RawEvent.threadKey` is `.nullable()` and **not** optional — every literal must
  pass `threadKey: null` explicitly.
- `canonical()` in `normalize.ts` is module-private; test it through `contentHash`.
- `normalize()` hashes the **stripped** body, not the raw one.

### packages/db
Ten tables, all with `org_id` (§15.4 — every query filters on it).

`events` `decisions` `tickets` `runs` `agent_events` `artifacts` `embeddings`
`outcomes` `overturns` `config`

Load-bearing details:
- `decisions` **is the thesis** and is also retrieval source #4. Immutable once
  written. Stores the three confidence components separately.
- `tickets` is created **only** by an ACCEPT decision — the gate is the only door
  into the work pipeline, so no path from event to code skips triage.
  `decisionId` is `onDelete: 'restrict'`; `uniqueIndex` on `eventId` so a
  redelivered webhook cannot fork the work.
- `events` — nothing is ever deleted; replayability depends on input rows
  persisting. `raw` holds the untouched provider payload so a `parse()` fix can
  be replayed without re-ingesting. `uniqueIndex(orgId, source, sourceRef)` makes
  webhook redelivery a no-op.
- `agent_events` is the project's own observability spine (Inngest free retains
  traces 24h, Vercel Hobby logs 1h). It is what Run Detail renders and what
  `DEMO_MODE=replay` reads back. **Never put a blob in `detail`** — blobs go to
  `artifacts` and are referenced by id.
- `embeddings` has **two** vector columns, `vec768` and `vec384`, on purpose:
  mixing 768- and 384-dim distances becomes a type error rather than a silent
  retrieval regression. HNSW not IVFFlat — IVFFlat needs a training pass over
  existing rows, useless on a table that starts empty.
- `config` exists so the autonomy threshold can change without a deploy. Read
  policy from here, not from constants.
- `overturns` stores an outcome **pair** (`fromOutcome`/`toOutcome`), not a
  boolean, so the confusion matrix is derivable.

`migrations/0000_noisy_northstar.sql` — 10 tables, 23 indexes, 11 FKs.
`CREATE EXTENSION IF NOT EXISTS vector;` is **hand-prepended as the first
statement**. drizzle-kit does not emit it and the vector columns fail without it.
**If you regenerate this migration, re-add that line.**

### packages/connectors
- `types.ts` — the §7.1 `Connector` interface, `VerifiableRequest`,
  `OutboundAction`, `WebhookError`
- `verify.ts` — `safeEqualHex` (timing-safe, length-checked first),
  `hmacHex`
- `github/payload.ts` — Zod schemas for the fields actually read, `isBot`
- `github/index.ts` — `githubConnector({ secret })`
- `github/github.test.ts` — 22 tests

Actions that produce events: issues `opened|reopened|edited`, PRs
`opened|reopened|ready_for_review`, comments `created`. Everything else returns
`[]`.

---

## 5. Decisions log

Append-only. These are choices a future agent could plausibly reverse by
accident, with the reason attached so the reversal is a considered one.

**D1 — `packages/db` relative imports have no `.js` extension; `core` and
`connectors` keep theirs.**
drizzle-kit 0.30.2 loads the schema through a CJS require and cannot map
`./enums.js` onto `enums.ts`, so `drizzle-kit generate` failed outright with
`MODULE_NOT_FOUND`. These packages are consumed as source under
`moduleResolution: Bundler` and never emitted to JS, so extensionless resolves
identically — confirmed by typecheck. Do not "fix" the inconsistency by adding
`.js` back to `packages/db`; it breaks migration generation.

**D2 — `CREATE EXTENSION IF NOT EXISTS vector;` is hand-added to the migration.**
drizzle-kit will not emit it. Must stay the first statement, before the
`vector(768)`/`vector(384)` columns and their HNSW indexes. Re-add after any
regeneration.

**D3 — `VerifiableRequest` is `{ headers: Headers; body: string }`, not a
Next.js `Request`.**
Keeps connectors testable with no HTTP and no framework, and makes "verify before
parse" a type-level obligation rather than a convention. The route handler is the
only place that touches `Request`.

**D4 — GitHub payload schemas validate only fields actually read, with
`.passthrough()`.**
GitHub payloads are enormous and their unread parts change without notice. The
full original is preserved in `RawEvent.raw`, so a `parse()` fix can be replayed
against stored rows rather than requiring re-ingestion.

**D5 — PR refs use `!`, issues use `#`.**
`acme/api!88` vs `acme/api#88`. Without this, PR 88 and issue 88 in the same repo
collide on `sourceRef` and one silently overwrites the other.

**D6 — a comment inherits its parent's `threadKey` but keeps its own
`sourceRef`.**
§7.3 thread collapsing: a 30-comment issue is ONE unit of work, not 30 triage
runs. Without it the cost model breaks — at ~25 LLM calls each, one busy thread
would eat a third of the daily Groq ceiling. The distinct `sourceRef` keeps
redelivery of a single comment idempotent.

**D7 — `mergeTargetId`/`missingInfo` conditional requirements are enforced by
`.superRefine`.** PLAN.md §5.1 declares them conditionally required but types
them `.optional()`, with nothing enforcing it. Now MERGE without a target and
DEFER without questions are Zod failures, in the same spirit as
`citations.min(1)` — which turns a hallucination class into a bounded retry via
the router's schema repair (§10.3).

**D8 — `orgId` added to `RawEvent`.** PLAN.md omitted it from `NormalizedEvent`
despite §15 requiring `org_id` on every table. Now inherited by
`NormalizedEvent` and present on all ten tables.

**D9 — `neon-http`, not the WebSocket pool driver.** Vercel Hobby caps functions
at 60s and Neon Free scales compute to zero, so a per-request HTTP call needing
no connection teardown beats a pool that must be drained before the function
freezes. The cost is **no interactive transactions** — every write in this
codebase must be a single statement or a batch, deliberately.

**D10 — Inngest, not Temporal.** Temporal Cloud has no free tier ($100/mo
minimum). Recorded because the plan names Temporal-style durable execution and
someone will reach for it.

**D11 — queue and cache are Postgres tables. No Redis.** One fewer service to
configure and to explain.

**D12 — `ModelSpec.scarcity` exists so the router does not spend burn-down credit
on ordinary traffic.** §10.2's score divides by latency, and Cerebras is the
*fastest* rung on the ladder (900ms vs the 70b's 1800ms), so it won the score
outright — while being a **$5 one-time** credit reserved for demo burst (§13.6).
`scarcity: 0.05` demotes it without touching the formula. Caught by a test, not by
reading: `router.test.ts` pins that the 70b still ranks first. E2B has the same
one-time-credit shape; if a second scarce provider is added, give it a scarcity
too rather than reordering the table.

**D13 — the injection guard fails OPEN.** A prompt-guard outage returns
`suspected: false` with the error in `signals`, not `suspected: true`. Failing
closed would mean one free-tier model being down routes *every* event in the
system to a human — a worse failure than missing a payload that layers 2 and 3
still have to get past. Deliberate, and the reason §15.3's honest framing is
"layers 1 and 2 reduce the rate; layer 3 bounds the damage."

**D14 — a fabricated citation forces ESCALATE.** Zod's `citations.min(1)` proves
citations *exist*; it cannot prove they are *real*, because `acme/api#412` is a
well-formed string whether or not that issue was ever retrieved.
`validateCitations()` checks every cited ref against the candidate block the model
was actually given. Without this, "every decision carries a citation" is a claim
about formatting rather than about evidence.

**D15 — a REJECT or MERGE with zero candidates is rewritten to ESCALATE.** With
nothing to compare against, a refusal is a guess. This is the one place the system
overrides the model on process rather than on confidence.

**D16 — `db/queries/` uses extensionless relative imports, like the rest of
`packages/db`.** Same reason as D1: drizzle-kit loads the schema through a CJS
require. The new query files import from `../client` and `../schema/*`, so they are
in the same resolution graph.

**D17 — `next.config.ts` sets `resolve.extensionAlias` so `.js` maps onto `.ts`.**
This is the fix for the D1 tension rather than a workaround for it. `core` and
`connectors` write ESM-correct `./ids.js` imports; `db` deliberately omits them.
TypeScript resolves both under `moduleResolution: Bundler`, but webpack looks for a
literal `ids.js` that is never emitted, because these packages are consumed as
source via `transpilePackages`. Without the alias, `next build` fails with
`Can't resolve './ids.js'`. **Do not "fix" that by stripping the extensions from
`core`** — that breaks nothing visibly and silently diverges the two conventions.
The Turbopack equivalent is `experimental.turbo.resolveExtensions` on 15.1; it
moved to top-level `turbopack` in 15.3.

**D18 — the router's schema parameter is `z.ZodType<T, z.ZodTypeDef, unknown>`,
not `z.ZodType<T>`.** The two-parameter form binds `T` to the schema's *input*
type, so every field with a `.default()` reads as `| undefined` at the call site
even though `parse` always fills it — which produced a dozen bogus
`possibly undefined` errors across `pipeline.ts`. Pinning the input to `unknown`
binds `T` to the **output** type, which is what the router actually returns since
it validates before returning. Both `CompleteOptions` and `CompleteFn` must keep
this shape or they drift apart.

**D19 — `ModelSpec` for agent 8 (Delivery) does not exist, because Delivery makes
no model call.** PLAN.md §4.1 lists it as a cheap-tier agent. Built as a pure
template instead: §8.1 requires the PR body's `Why` to be the triage reasoning
*verbatim* because it is the audit trail, and a model asked to write it would
paraphrase. A template also cannot embellish, cannot claim work absent from the
diff, and costs nothing against a 1,000 RPD ceiling.

**D20 — `assertion` counting in `detectTestErosion` counts occurrences, not
matching lines.** Per-line counting looks equivalent and is not: collapsing three
`expect`s onto one line, or deleting two of three assertions from a single-line
test, nets to zero and passes. That is precisely the evasion §14.3 exists to catch.
Found by a test, and the reason `ASSERTION`/`TEST_DECL` are global regexes read
through `matchAll`.

**D21 — `applyHunks` special-cases `original === ''`.** `''.split('\n')` is `['']`,
not `[]`, so every newly created file gained a leading blank line and every
subsequent hunk's context was offset by one. Silent: the diff applied "successfully"
and the sandbox tested a file nobody wrote.

**D22 — the injection guard runs in the webhook handler, not in the triage
function.** `injectionSuspected` is a column on `events`, so it must be set at
insert time — by the time triage reads the row it is too late to classify. This
means the guard's ~200ms is inside Vercel's 60s budget rather than Inngest's, which
is fine at one cheap 86m-parameter call per event.

**D23 — `spawn`'s `env` in the local sandbox driver is cast through `unknown`.**
Next augments `NodeJS.ProcessEnv` to make `NODE_ENV` required, so an object literal
fails overload resolution *only when compiled as part of `apps/web`* — and the
failure collapses `child` to `never`, cascading into six unrelated-looking errors.
Deliberately not "fixed" by adding `NODE_ENV`: forcing a value would change how the
repo under test builds itself.

---

## 6. Rules that must not be broken

Two load-bearing invariants. Violating either quietly destroys a property the
whole design rests on.

**R1 — every agent is a pure function `(ctx) => output`.** No agent touches
Linear, GitHub, or the DB directly; only the workflow layer does I/O. This is why
all seven agents are unit-testable with no network and why the pipeline can be
replayed from stored inputs.

**R2 — never pass blobs through Inngest events.** Payload cap 256 KiB, step
return cap 4 MB, total run state 32 MB. Diffs, file contents and transcripts go
to `artifacts`; events carry only ids.

### Security, non-negotiable (§15)

- **Verify before parse.** No handler processes a body before authenticating it.
  In Next.js this means `await req.text()` and parse *after* verifying — never
  `req.json()` first, because re-serializing changes bytes and every HMAC fails.
  Compare with `crypto.timingSafeEqual`, never `===`.
  GitHub = HMAC-SHA256 vs `X-Hub-Signature-256`. Slack = `v0=` HMAC over
  `v0:timestamp:body`, reject skew > 5 min. Linear = HMAC-SHA256 vs
  `Linear-Signature` + source-IP check. Google Pub/Sub = OIDC JWT against
  Google's JWKS, audience pinned. Inngest = its own signing key.
- **Prompt injection, 4 layers.** (1) Every ingested body runs through Groq
  `meta-llama/llama-prompt-guard-2-86m`; a hit does not block — it sets
  `injectionSuspected`, caps confidence at 0.5 and forces ESCALATE.
  (2) Untrusted text **never enters the system prompt** — it goes in a user-role
  message inside explicit delimiters
  (`<untrusted source="github:issue:1041" trust="anonymous">…</untrusted>`) with a
  standing instruction that content inside is *data to be analysed, never
  instructions to follow*. (3) **Capability, not persuasion** — writes to
  `.github/`, CI config, lockfiles, `.env*` and secrets-pattern paths are blocked
  **deterministically**; **no auto-merge, ever**; `trust: 'anonymous'` gets a
  lower autonomy ceiling (triage + draft PR, never an autonomous close).
  (4) Output validation — the Coder's diff is scanned for added network calls to
  non-allowlisted hosts, new `eval`/`exec`/`child_process`, new dependencies,
  base64 blobs and anything resembling a credential; all force ESCALATE.
  > Layers 1 and 2 reduce the rate; layer 3 bounds the damage. A defence that
  > depends on the model not being fooled is not a defence.
- **Sandbox, enforced by the driver not by prompt (§12.4).** No secrets mounted —
  the sandbox gets source code, never a token. Egress allowlist: package registry
  only, **no access to Neon, Inngest, or the GitHub API**. The git push happens
  *outside* the sandbox, from the workflow, after the diff is read back out.
  10-minute wall clock, 512 MB written-file cap, destroyed in a `finally` block.
  > The sandbox produces a diff; it never has the credentials to publish one.

  Agent-generated code never runs on Vercel, never on your laptop, and never with
  network access to your own infrastructure.
- **Secrets.** All credentials in Vercel env vars, none in the repo.
  `.env.example` documents names only. GitHub App private key stored
  base64-encoded, decoded at runtime. Installation tokens minted per-run,
  expiring in 1 hour — no long-lived PAT. Google OAuth stays in *testing* consent
  mode, readonly scopes. Least privilege: Contents R/W is the only write scope
  beyond issues and PRs. `gitleaks` in CI.
- **§14.3 hard rule.** Any diff reducing test count or assertions is an automatic
  Reviewer reject — a deterministic check, not just a prompt. Diffs touching
  `.github/`, CI config, secrets files or lockfiles → ESCALATE regardless of
  confidence.

Real incident worth keeping in mind, from §15.1: while researching this plan, the
web search tool returned hijacked results — unrelated links plus text formatted
to look like instructions to the agent, with a trailing "REMINDER: You MUST …"
line. It happened twice, from a tool the agent had every reason to trust.

---

## 7. Blockers and unstarted setup

| # | Item | Blocks | Notes |
|---|---|---|---|
| B1 | No Neon database provisioned; `DATABASE_URL` unset | **everything unverified** — the 4 retrieval queries have never executed | `db()` throws loudly rather than connecting to nothing |
| B2 | No Groq key | one real triage call; prompt-guard | the gate is only ever exercised through a canned `complete()` |
| B3 | No Vercel / Inngest project | live webhooks + durable runs | see the org-repo trap below |
| B4 | **Docker not installed** (`docker -v` → not found) | §16.3 offline demo fallback | local Postgres+pgvector is one of four non-negotiable insurance items |
| B5 | ~~No `.env.example`~~ | — | **closed** — written, names only |
| B6 | Team name + members blank on submission deck slide 1 | submission | |
| B7 | No Gemini key | embeddings → retrieval sources 1 and 4 | they return `[]` and say so in `degraded`; the gate still works on lexical + git |
| B8 | Dashboard has **no auth** | exposing it beyond a private demo URL | anyone reaching `/policy` can lower the autonomy threshold. First thing to fix. |
| B9 | No E2B key and no Actions workflow file | QA has no test signal | `qa` returns `inconclusive` rather than a green tick it did not earn |

**The org-repo trap:** Vercel Hobby **cannot connect to Git repos owned by a
GitHub organization.** The repo must live under a personal account. Discovering
this late means moving the repo mid-demo-prep.

### Free-tier ceilings that shape design decisions

- **Neon Free suspends compute for the rest of the billing month** on exceeding
  any limit (0.5 GB storage / 100 CU-hours / 5 GB egress). Suspended, not
  throttled.
- **Vercel Hobby functions cap at 60s**, so a webhook handler may only
  verify → insert → emit → 200. All real work is deferred to Inngest.
- **Groq `llama-3.3-70b-versatile` is 1,000 requests/day org-wide** ≈ **40
  tickets/day** at ~25 calls each. This is the real binding ceiling. Groq limits
  are **per organization, not per key** — a second key buys nothing; headroom
  comes from spreading across *models*.
- **Inngest free retains traces 24h; Vercel Hobby logs 1h.** Hence
  `agent_events`.
- **OpenRouter free is 50 RPD** until $10 lifetime spend, then 1,000 RPD.
- **Granola has no public API.** Three ingestion paths, all producing identical
  `NormalizedEvent`s with `kind: 'meeting_note'`: Drive-watched export, a
  paste-in textarea, and a `/ascendant note` Slack command.

---

## 8. Architecture reference

Enough to work without re-reading all of `PLAN.md`. Section refs point into it.

### Stack

| Concern | Choice | Why |
|---|---|---|
| App / API / dashboard | Next.js on Vercel | free Hobby; API routes are the webhook receivers |
| Durable execution | Inngest | see D10 |
| Database | Neon Postgres + pgvector | pgvector on Free, scale-to-zero |
| Sandbox | E2B primary, GitHub Actions fallback | Firecracker microVM isolation |
| LLM | Groq → Gemini → OpenRouter `:free` cascade | |
| Queue / cache | Postgres tables | see D11 |
| Validation | Zod | one schema validates LLM output *and* HTTP bodies |
| ORM | Drizzle | typed SQL, Neon serverless driver |
| Observability | Inngest traces + own `agent_events` | Inngest retention is 24h |

### Agents

Orchestrator (cheap 8b), Triage (strong 70b), Research, Planner, Coder
(strongest), Reviewer, QA, and Delivery (cheap templating — deliberately *not*
"intelligent").

**Sequential bounded debate**, designed around Inngest's 5-concurrency cap: each
*round* is one `step.run()`, with the multi-turn argument as a plain `for` loop of
LLM calls **inside** that step. ~6 steps per ticket, not 20.
Round 1: Planner proposes → Reviewer critiques → Planner revises.
Round 2: Coder writes diff → Reviewer critiques → Coder revises.
Round 3: QA runs tests → on failure the Coder gets the failure, max 2 retries.

### Five Inngest functions

`ingest` (`event/received`) → `triage` (`triage/requested`) → `plan-and-code`
(`work/accepted`) → `qa` (`review/ready`) → `deliver` (`delivery/ready`).
DEFER and ESCALATE use `step.waitForEvent` with a 72-hour timeout.

### Router contract (§10)

Every agent calls only this. No agent knows which provider served it.

```ts
export async function complete<T>(opts: {
  task: 'triage'|'plan'|'code'|'review'|'qa'|'summarize'|'classify'
  schema: z.ZodType<T>
  system: string
  messages: Message[]
  ticketId?: string          // for budget accounting
}): Promise<{ value: T; model: string; tokens: number; latencyMs: number }>
```

Cascade (§10.1): Groq `llama-3.3-70b-versatile` → Groq `openai/gpt-oss-120b` →
Gemini `2.5-flash` → OpenRouter `<model>:free` → Cerebras ($5 one-time, demo
burst only). Cheap tier: Groq `llama-3.1-8b-instant`. Injection scan: Groq
`llama-prompt-guard-2-86m`. **All tiers exhausted → ESCALATE with
`reason: 'no_capacity'`** — never a silent failure.

Rung selection (§10.2):
`score = available(model) × fits(estimatedTokens, tpmRemaining) × capability(task, model) / expectedLatencyMs`.
429 → cooldown until `X-RateLimit-Reset`.
Schema repair (§10.3): one retry with the Zod error appended, then escalate the
**rung, not the ticket**; two schema failures on the same model downgrade that
model's `capability(task, model)` for the run.
Budget (§10.4): 60,000 tokens / 25 LLM calls per ticket; 400k tokens/day org.

### pgvector (§9.1)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE embeddings ADD COLUMN vec vector(768);
CREATE INDEX ON embeddings USING hnsw (vec vector_cosine_ops);
```
`text-embedding-004` via Gemini free tier, 768 dims. Fallback `bge-small-en`,
384 dims, **in a second column so the two are never compared**.

### Delivery (§8.1)

Branch `ascendant/<linear-id>-<slug>`, never `main`. Commit trailer:

```
Fix session id crash on expired token (ENG-142)

Co-Authored-By: Ascendant <ascendant@users.noreply.github.com>
Ascendant-Decision: <decision-uuid>
Ascendant-Confidence: 0.87
```

PRs open as **draft** when confidence < 0.80. **Never auto-merged.**

### SandboxDriver (§12.4)

```ts
export interface SandboxDriver {
  create(spec: { image: string; timeoutMs: number }): Promise<Handle>
  writeFiles(h: Handle, files: FileMap): Promise<void>
  exec(h: Handle, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
  readFile(h: Handle, path: string): Promise<string>
  destroy(h: Handle): Promise<void>
}
```

### Connector (§7.1)

```ts
export interface Connector {
  id: SourceId
  verify(req: Request): Promise<boolean>          // signature check, per §15.2
  parse(raw: unknown): Promise<RawEvent[]>        // 1 payload → n events
  hydrate?(e: RawEvent): Promise<RawEvent>        // fetch thread/parents if needed
  respond?(action: OutboundAction): Promise<void> // comment, close, react, reply
}
```
As built, `verify` takes a `VerifiableRequest` rather than a `Request` — see D3.

---

## 9. Demo (§16), 4 minutes

The demo is a deliverable, not an afterthought — build toward these beats.

1. **Open with a rejection.** File *"Please add a GraphQL endpoint for sessions"*
   → REJECT, confidence 0.89, citing a seeded architecture decision doc that says
   *"we are not adding a GraphQL layer, decided 2026-06-12."* Leading with a
   refusal is the whole pitch.
2. The other three non-ACCEPT paths: MERGE, DEFER, ESCALATE.
3. A genuine bug → ACCEPT → Run Detail timeline as a structured thread → a real
   draft PR carrying the decision trailer.
4. The eval confusion matrix, then drag the autonomy threshold 0.80 → 0.95 in the
   Policy view and re-run beat 1's issue: same decision, now routed to a human.

**Four non-negotiable insurance items (§16.3):**
1. A recorded 4-minute screen capture.
2. `pg_dump` of the seeded DB committed, plus local Postgres+pgvector via Docker
   (blocked — B4).
3. `DEMO_MODE=replay` serving stored `agent_events` at their original timing.
4. **Run `pnpm eval` the night before, not the morning of** — it is ~1,500 Groq
   requests against a 1,000 RPD ceiling.

---

## 10. Commands

```bash
pnpm install              # pnpm@9.15.4, pinned via packageManager
pnpm -r typecheck         # all 8 workspace projects
pnpm test                 # vitest run, from the root; no vitest.config.ts needed
pnpm db:generate          # drizzle-kit generate — re-add the vector extension line (D2)
pnpm db:push              # needs DATABASE_URL
pnpm --filter @ascendant/web build   # next build — catches resolver problems typecheck cannot (D17)
pnpm --filter @ascendant/web dev     # dashboard on :3000
pnpm seed:demo            # scripts/seed-demo.ts — not written yet
pnpm eval                 # scripts/eval.ts — not written yet
```

`pnpm -r typecheck` passing is **not** sufficient before a deploy: webpack resolves
module paths differently from `tsc`, so run the `web build` too. D17 and D23 were
both invisible to typecheck alone.

Environment: Windows 11, bash shell, node ≥20, git repo initialised on `main`
with no commits yet.

Pinned versions worth knowing, all chosen to avoid a workspace-wide bump:
`inngest@3.39.2` (3.44+ requires TypeScript ≥5.8; 3.54+ also requires zod ≥3.25),
`next@15.1.6` with `react@19.0.0`, `typescript@5.7.3`, `zod@3.24.1`,
`drizzle-orm@0.38.4`. `e2b` is deliberately **not** installed — it is loaded through
a runtime-built specifier so the Actions and local drivers work without it.

