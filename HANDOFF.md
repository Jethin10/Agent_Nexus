# HANDOFF

Living status doc for Ascendant. Read this first, before `PLAN.md`.

**Maintenance rule:** update this file whenever a §17 step completes, a decision is
made that a future agent could accidentally revert, or a blocker opens or closes.
Append to the Decisions log — never rewrite history there. Keep the Status board
and Next step accurate; everything else is reference.

Last updated: 2026-08-12 · production integration cutover is code-complete; credentials remain external

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
| 2 | Triage Gate + retrieval + decision object | **done** — and now *executed*, see below |
| 3 | Dashboard Inbox + Run Detail | **done** (Inbox, Run Detail, Metrics, Policy) |
| 4 | Inngest workflows + LLM router | **done** (6 functions, router, budget) |
| 5 | Planner/Coder/Reviewer/QA + E2B sandbox | **done** (8 agents, 3 drivers) |
| 6 | Delivery: PR + Linear + Slack | **done** — real API paths, signed Slack actions, GitHub App tokens |
| 7 | Remaining inbound connectors (Gmail/GCal/Drive/Granola) | todo |
| 8 | Learning loop + eval set + metrics | queries + views **done**; `pnpm eval` **written and passing 5/5** — the set needs growing to 60 |
| 9 | Security layers 1-4 hardening | all 4 layers **done**; dashboard auth **done** (B8 closed) |
| 10 | Offline test fixtures and replay fallback | **done**; retired from the product navigation |

**The system now runs.** Until 2026-07-31 nothing in this repo had ever executed:
no database existed, so the four retrieval queries had never touched Postgres, and
the gate had only been exercised through a canned `complete()`. That is no longer
true, and running it found four real bugs (§5, D24-D27).

```
pnpm seed:demo   28 events, 42 embeddings, 14 decisions, 6 tickets, 1 overturn
pnpm demo        all five outcomes produced by the real gate, from a clean database
pnpm dev         four views rendering that data at localhost:3000
```

Verification state right now: `pnpm -r typecheck` clean across all **9** workspace
projects, `pnpm test` = **363 passing**, and `next build` compiles all 7 routes.

| suite | tests |
|---|---|
| core: extract / normalize / policy / confidence / candidates / prompt / diff | 10 / 22 / 24 / 20 / 17 / 19 / 29 |
| connectors: github | 22 |
| router: cascade, repair, budget, guard | 34 |
| agents: triage / pipeline / delivery | 18 / 19 / 26 |
| sandbox: guards + local driver | 33 |
| workflows: applyDiff + repo client | 16 |
| **db: retrieval against real Postgres** | **18** |
| **scripts: offline model / embedder** | **20 / 6** |
| **web: replay schedule** | **10** |

---

## 3. Next step, concretely

**Provision credentials, deploy, then execute one bounded real issue end to end.**

The production code paths are now present for GitHub App authentication, signed GitHub
and Slack webhooks, durable Inngest execution, Neon/Postgres, live model routing, E2B or
Actions QA, Linear state updates, Slack review messages, and GitHub PR publication. The
fixture walkthrough has been removed from navigation; `/demo` redirects to the
credential-safe `/integrations` runtime status page. Fixture scripts remain for tests
and offline development only.

1. **Provision the external services.** The latest read-only check found live model
   access but no repository/webhook, database, Slack, Linear, sandbox, Inngest, or
   dashboard credentials in this checkout. No code can manufacture those credentials.
   Fill the names in `.env.example` in Vercel or `.env.local`, then run
   `pnpm integrations:check --strict` until all required connections are ready.
2. **Deploy and register callbacks.** Apply `pnpm db:push`, deploy the web app, then
   configure GitHub at `/api/webhooks/github`, Slack at `/api/webhooks/slack`, and
   Inngest at `/api/inngest`. Production GitHub access should use
   `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_BASE64`; `GITHUB_TOKEN` is local-only.
3. **Run one real bounded issue.** Verify webhook receipt, persisted decision, source
   comment/label, Slack and Linear updates, sandbox QA, and the final reviewable PR.
   Never use an important repository for the first rehearsal and never auto-merge.
4. **Grow the eval set to 60 issues** (step 8, §11.2). The harness still has only the
   smaller smoke set. Metrics seeded history and eval accuracy are different inputs;
   do not present them as the same measurement.

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

```
scripts/                    the 9th workspace project — runs the system offline
  seed-demo.ts              builds the corpus; seeds nothing that decides anything
  demo.ts                   drives the five §16.2 scenarios through the real gate
  lib/fixtures.ts           28 events incl. the ADR the graphql scenario cites
  lib/context.ts            openLocalDb + openRunContext — the one place the
                            fixture/real model and local/remote db choices are made
  lib/offline-model.ts      fixture `complete()` (D29)
  lib/embed.ts              hashed pseudo-embeddings (D27)
```

`scripts/eval.ts` is the one piece still missing — it needs the 60 hand-labelled
issues, not just the harness.

The seed and the runner are deliberately **separate programs**: the seed writes only
history, and every outcome the demo shows is produced by `triage()` at run time. If
those ever merge, the demo's central claim — that the outcomes are decided, not
replayed — stops being verifiable.

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

The next four were found by *running* the system for the first time (2026-07-31).
None was visible to `tsc` or to the 309 tests that existed before. Recording them
together because they share a lesson: the parts of this system whose correctness
lives in SQL, in a cast, or in a calibration constant cannot be verified by a
typecheck, and three of the four failed silently rather than loudly.

**D24 — the offline path is PGlite, not Docker + Postgres.**
§16.3 insurance item 2 assumed Docker; it is not installed here (B4). PGlite is
real Postgres compiled to WASM, in-process, no daemon and no port. Every feature
the retrieval layer needs works under it: the `vector` extension, `vector(768)`,
HNSW indexes, the `<=>` cosine operator, `websearch_to_tsquery`/`ts_rank`, and the
jsonb `?|` overlap. `drizzle-orm/pglite` ships inside the pinned 0.38.4, so this
cost no version bump.

Two consequences worth not reverting. First, `Db` is now drizzle's driver-agnostic
`PgDatabase<PgQueryResultHKT, typeof schema>` rather than one driver's concrete
return type — that is what lets the ten tables' queries be written once and run
against both neon-http and PGlite. Pinning it back to `ReturnType<typeof makeDb>`
would fork every query into two implementations. Second, PGlite is a **subpath
export** (`@ascendant/db/local`) and is in `serverExternalPackages`: it locates its
WASM and its gzipped extension bundles relative to its own module URL, and webpack
rewrites those into `/_next/static/media/...` asset URLs that the loader cannot
read. That failure appears at *request* time as
`Extension bundle not found: …/vector.tar.<hash>.gz`, with a clean build and a
clean typecheck.

**D25 — `decisionMemory` had to cast `uuid` to `text`, not the reverse.**
It joined `embeddings.entity_id` (text, because the table is polymorphic across
events, decisions, tickets and docs) to `decisions.event_id` (uuid). Postgres has
no implicit `text = uuid` cast, so the query threw **every time it ran**.
`retrieveCandidates` catches per-source failures by design, so this never surfaced
as an error — retrieval source 4 simply returned `[]` on every triage, and the gate
silently lost the memory of its own judgements. That is the source that makes a
re-filed rejected issue cite its own prior rejection (§5.3 item 4). Cast the uuid,
not the text column: casting the other way makes the comparison unsargable and
discards the index on `entity_id`.

**D26 — vector candidates cite the upstream ref, not the internal uuid.**
`vectorNeighbours` returned `embeddings.entity_id` as `Candidate.ref`. §5.1 requires
"a URL or stable id", the §5.5 reject comment quotes `#412`, and `validateCitations`
matches the model's citation against these refs — so a citation reading
`0b102ab6-…` was unreadable to the human the comment is written for and unmatchable
against anything a person would type. Now left-joins `events` to surface
`source_ref`, falling back to the entity id for embeddings that are not events
(decision rows, doc chunks). Pinned by a test that asserts the ref is not a uuid.

**D27 — the offline embedder is rescaled to the range the evidence calibration
expects; `EVIDENCE_FLOOR` was NOT lowered.**
Without `GEMINI_API_KEY` the seed generates deterministic hashed term vectors, so
retrieval sources 1 and 4 exercise the real pgvector path instead of returning `[]`.
Raw hashed bags-of-terms discriminate correctly but compress into ~0.1-0.35 cosine,
while `EVIDENCE_FLOOR` is 0.62 — calibrated for `text-embedding-004`, where
unrelated same-repo documents genuinely sit at 0.5-0.6. Feeding raw hashed scores
into that calibration collapsed `evidenceStrength` to 0 for *every* event, so no
decision could ever be autonomous and the gate looked broken.

The tempting fix — lower `EVIDENCE_FLOOR` — would corrupt the real inference path to
flatter a fixture. The rescaling instead lives in `scripts/lib/embed.ts`, the file
already labelled as not-semantic, and is covered by a test asserting that related
documents clear the floor while unrelated ones stay measurably below them. **These
vectors are a lexical proxy, not a learned space**; the seed output says so.

**D28 — `toNormalized` is exported from `workflows/triage.ts`.**
It is the only code that knows how a flat `EventRow` (`actorId`/`actorHandle`/
`actorIsBot`) maps onto a nested `NormalizedEvent` (`actor`). While it was private,
the demo runner cast between the two instead: the cast typechecked and then threw
inside the policy rules on the first real run. Any caller replaying a stored row —
the runner, a future eval harness — must go through it rather than casting.

**D29 — the offline model is a fixture, and says so in every row it touches.**
`scripts/lib/offline-model.ts` supplies `AgentContext.complete` when no LLM key is
set. R1 (agents are pure, `complete` is injected) is what makes this reach all eight
agents without touching one of them. Three properties keep it honest: every response
is labelled `fixture:<task>`, which lands in `agent_events.model` and
`decisions.model_used`; the response is validated through the *caller's* own Zod
schema, so a drifted fixture fails exactly as a bad model response would; and the
triage fixture reads candidate refs out of the prompt it was handed, so it can only
cite evidence retrieval actually returned. Reported token cost is 0, because a
fixture consumed no quota and reporting otherwise would corrupt the budget
accounting on the dashboard.

Two things the fixture had to learn that a real model gets for free, both found by
running it: intent must be read from the **event** section of the prompt rather than
the whole prompt (the seeded corpus discusses all five scenario topics, so every
scenario matched the first branch), and a shared exception is not enough to justify
MERGE (the ACCEPT scenario reports the same `TypeError` from the same file for a
*different* trigger, and merging those buries real work under a closed issue — the
expensive triage mistake).

**D30 — production GitHub access prefers App installation tokens; PATs are local-only.**
`repoFromEnv()` is async because it signs a nine-minute RS256 app JWT, resolves the
configured repository installation, and mints a repository-scoped token for each
workflow invocation. The token is never persisted, logged, sent to an agent, or placed
inside an E2B sandbox. If only one of `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY_BASE64` is set, configuration fails closed instead of silently
falling back to `GITHUB_TOKEN`. A local token additionally requires
`ASCENDANT_ALLOW_GITHUB_TOKEN=1`; never set that flag in production. Source-response
authentication failures are traced as degradation after the immutable decision is
stored; they do not erase or re-run triage.

**D31 — fixtures remain test infrastructure, not a product surface.**
The `/demo` route redirects to `/integrations`, the walkthrough component was removed,
and primary documentation now starts from signed webhooks plus production readiness.
`seed:demo`, `demo`, `demo:build`, and timeline replay remain because they provide
hermetic tests, CI coverage, and outage recovery. Do not reconnect them to primary
navigation or claim their fixture reasoning is a live server result.

**D32 — every GitHub redelivery re-emits the same deterministic Inngest event id.**
The database insert can succeed while `inngest.send()` fails. GitHub then retries, but
the row already exists; sending only when `inserted === true` permanently stranded that
event. The webhook now always sends `ascendant:event:<event uuid>`. Inngest deduplicates
a successful first send, while a failed first send is repaired by the redelivery. The
triage workflow's immutable decision check remains the downstream idempotency boundary.

**D33 — a valid App signature does not authorize every installed repository.**
A GitHub App webhook secret is shared across installations. Without an explicit
`GITHUB_OWNER/GITHUB_REPO` source-ref check, an issue from any repository carrying a
valid App signature could enter the pipeline and generate work against the configured
repository. Relevant events are now rejected with 403 before persistence unless their
issue, PR, or comment ref belongs to the configured repository. This deployment remains
intentionally single-repository until installation identity is persisted per org.

**D34 — production retrieval uses `gemini-embedding-001` with task-specific 768d vectors.**
`text-embedding-004` is retired. New events are idempotently stored as
`RETRIEVAL_DOCUMENT`, while the current triage text is embedded as `RETRIEVAL_QUERY`.
The model name is stored beside every vector, and maintenance re-embeds missing or
older-space rows in bounded batches. Provider failure remains an explicit retrieval
degradation and cannot become a confident refusal. `pnpm corpus:sync` backfills real
issues and merged PRs before first traffic.

**D35 — only confirmed merged PRs count as “already fixed on main.”**
Opened and closed-unmerged PRs remain useful event context but are excluded from
`gitActivity`. A merged closure gets the immutable ref `<repo>!<n>:merged`, sharing the
original PR thread without colliding with its opened row. Corpus sync uses that same ref.

**D36 — production QA requires the pinned E2B SDK.**
The `e2b` runtime dependency is installed and readiness requires `E2B_API_KEY`.
GitHub Actions remains experimental behind `ASCENDANT_ALLOW_ACTIONS_SANDBOX=1`; its
input path now refuses oversize payloads rather than truncating source code. E2B uses a
fixed absolute workspace, creates it before execution, strips secret-shaped environment
variables, and installs dependencies without lifecycle scripts. Local execution remains
development-only and never satisfies production readiness.

**D37 — human mutations are authorized and replay-safe.**
Slack decisions require an exact member id in `SLACK_REVIEWER_IDS`. Dashboard mutation
requests must be same-origin in addition to valid Basic authentication, and audit rows
use the configured `ASCENDANT_OPERATOR_NAME`. Human-resolution Inngest events carry
stable ids, so repeating an already-persisted review repairs a failed dispatch without
duplicating continuation.

**D38 — deployed builds fail closed on the complete single-repo runtime contract.**
Deployment markers require durable Postgres, signed Inngest keys, GitHub App and webhook,
Gemini retrieval, E2B, Slack plus reviewer allowlist, Linear, and the dashboard gate.
Local and CI builds remain credential-free. Maintenance marks non-triage runs stale after
two hours; triage is excluded because it may legitimately wait 72 hours for a human.
GitHub PR creation recovers an existing open PR after a retry-time 422. Decision comments
are content-idempotent, GitHub source-response failures retry safely, and post-PR Slack/
Linear failures now fail their isolated Inngest step so notification delivery retries
without recreating the PR.

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
| B1 | ~~No Neon database~~ | — | **downgraded** — `ASCENDANT_LOCAL_DB=1` opens a real Postgres in-process (D24) and the 4 retrieval queries now run in CI. Neon is still needed to *deploy*, not to work. |
| B2 | ~~No Groq key~~ | — | **downgraded** — the gate has run on live inference via `OPENROUTER_API_KEY`; the router cascade takes whichever key is present, so Groq specifically is not required. With no key at all the reasoning is a fixture labelled `fixture:*` (D29) and everything around it is still real. |
| B3 | No Vercel / Inngest project | live webhooks + durable runs | see the org-repo trap below. `pnpm demo` drives the same functions without them. |
| B4 | ~~Docker not installed~~ | — | **closed** — PGlite replaces it and needs no daemon (D24) |
| B5 | ~~No `.env.example`~~ | — | **closed** — written, names only |
| B6 | Team name + members blank on submission deck slide 1 | submission | |
| B7 | No Gemini key | *semantic* embeddings | sources 1 and 4 work offline on hashed vectors — a lexical proxy, not a learned space (D27) |
| B8 | ~~Dashboard has no auth~~ | — | **closed** — HTTP Basic over `ASCENDANT_DASHBOARD_PASSWORD` in `apps/web/src/middleware.ts`; a deploy without it fails the build. Unset still falls open for local `pnpm dev`, which is deliberate: see `src/lib/deploy-guard.ts`. |
| B9 | No E2B key and no Actions workflow file | QA against a real repo | `localDriver` gives a real test signal offline via `ASCENDANT_ALLOW_LOCAL_SANDBOX=1`; `qa` still returns `inconclusive` rather than a green tick it did not earn |
| B10 | No recorded 4-minute screen capture | §16.3 insurance item 1 | the only one of the four still missing: seed, `DEMO_MODE=replay` and the offline DB are all done |

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

Beats 1-3 run today via `pnpm demo`, at 0.88 / 0.86 / 0.78 / 0.64 / 0.85 confidence
respectively, and each writes a Run Detail page. Beat 4's matrix renders off the
seeded history at **91.7%**; the threshold drag works through the Policy view.
Substituting a real eval set changes the numbers, not the wiring.

Two caveats to state out loud rather than hope nobody asks. The ACCEPT beat opens a
ticket but does not yet produce a PR offline — that needs `GITHUB_TOKEN` and a real
repo (B3/B9). And the reasoning text is a fixture until `GROQ_API_KEY` is set (D29);
the retrieval, policy, confidence and banding around it are real either way. Better
to say so than to be caught claiming inference that did not happen.

**Four non-negotiable insurance items (§16.3):**
1. A recorded 4-minute screen capture — **still missing (B10)**, and now the only
   one. Record it against the offline path so it cannot break on the day.
2. ~~`pg_dump` + Docker~~ → **done differently.** `pnpm seed:demo` rebuilds the
   database from source fixtures in ~15s with no daemon and no network (D24), which
   is strictly better than a dump: it is diffable, reviewable, and regenerates
   rather than restores.
3. ~~`DEMO_MODE=replay`~~ → **done.** Run Detail reveals stored `agent_events` at
   their original relative pacing, labelled as a replay.
4. **Run `pnpm eval` the night before, not the morning of** — it is ~1,500 Groq
   requests against a 1,000 RPD ceiling. Still applies, unchanged.

The demo now has no hard dependency on network, keys, Docker, or a cloud database.
That was the point of §16.3.

---

## 10. Commands

The three-command demo, no keys and no network required:

```bash
pnpm seed:demo            # ~15s. Fresh local Postgres, 28 events, 42 embeddings,
                          #   14 historical decisions, 6 tickets, 1 overturn.
                          #   --keep to add to an existing database instead.
pnpm demo                 # Puts the five §16.2 scenarios through the real gate.
                          #   Exits non-zero if any outcome is not the expected one.
                          #   `pnpm demo graphql` runs one by id; --verbose shows
                          #   every trace line and the full candidate set.
pnpm dev                  # Dashboard on :3000 against that same local database.
                          #   pnpm dev:replay for DEMO_MODE=replay.
                          #   Both go through cross-env — a bare `VAR=1 pnpm ...`
                          #   fails on Windows, where pnpm runs scripts via cmd.exe.
```

Scenario ids: `graphql` `duplicate` `no-repro` `ambiguous` `real-bug`.

Everything else:

```bash
pnpm install              # pnpm@9.15.4, pinned via packageManager
pnpm -r typecheck         # all 9 workspace projects
pnpm test                 # vitest run, from the root; 363 tests
pnpm db:generate          # drizzle-kit generate — re-add the vector extension line (D2)
pnpm db:push              # needs DATABASE_URL
pnpm --filter @ascendant/web build   # next build — catches resolver problems typecheck cannot (D17, D24)
pnpm eval                 # scripts/eval.ts — not written yet
```

Env vars that change behaviour rather than just supplying credentials:

| var | effect |
|---|---|
| `ASCENDANT_LOCAL_DB=1` | use in-process PGlite at `.ascendant/pgdata`. **Ignored when `DATABASE_URL` is set**, so it cannot shadow a real database by accident. |
| `DEMO_MODE=replay` | Run Detail reveals stored `agent_events` at their original relative pacing, with a banner saying so |
| `DEMO_MODE=live` | badge only; no behaviour change |
| `GROQ_API_KEY` | swaps the fixture model for the real router (D29) |
| `GEMINI_API_KEY` | swaps hashed vectors for `text-embedding-004` (D27) |
| `ASCENDANT_ORG_ID` | defaults to `org_demo`; the seed, the runner and the dashboard must agree |

`pnpm -r typecheck` passing is **not** sufficient before a deploy: webpack resolves
module paths differently from `tsc`, so run the `web build` too. D17, D23 and D24
were all invisible to typecheck alone — and D24 was invisible to the build as well,
surfacing only on a request.

Environment: Windows 11, bash shell, node ≥20, git repo on `main`. `.ascendant/` and
`evals/` are gitignored; the local database is disposable and `pnpm seed:demo`
recreates it from scratch.

Pinned versions worth knowing, all chosen to avoid a workspace-wide bump:
`inngest@3.39.2` (3.44+ requires TypeScript ≥5.8; 3.54+ also requires zod ≥3.25),
`next@15.1.6` with `react@19.0.0`, `typescript@5.7.3`, `zod@3.24.1`,
`drizzle-orm@0.38.4`. `e2b` is deliberately **not** installed — it is loaded through
a runtime-built specifier so the Actions and local drivers work without it.

