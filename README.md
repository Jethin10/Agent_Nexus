# Ascendant

**Decides what to build. Then builds it.**

Every coding agent on the market — Devin, OpenHands, Copilot Workspace, Factory, Sweep — starts from the same assumption: *the ticket is valid*. They begin at "implement this."

The expensive failure in a real engineering org is upstream of that. Duplicate tickets. Tickets that contradict a decision made in a meeting three weeks ago. Tickets that are user error. Tickets already fixed on `main`. Tickets that are one line in a Slack thread and shouldn't be tickets at all.

Ascendant's **Triage Gate** decides whether the work is real before any of it gets built. It has five outcomes, and **four of them are refusals**:

```
Event Sources ──► Normalizer ──► TRIAGE GATE ──► Work Pipeline ──► Delivery ──► Learning Loop
                                      │
                                      ├─► REJECT   comment + close, with reasoning
                                      ├─► MERGE    link as duplicate of an existing ticket
                                      ├─► DEFER    needs info → ask the human, wait
                                      ├─► ESCALATE low confidence → a human decides
                                      └─► ACCEPT   → ticket → the build pipeline
```

The multi-agent debate, coding, review, QA and delivery are all here — they are the *body*. The gate is the *thesis*.

---

## Try it in three commands

No API keys, no Docker, no database, no network.

```bash
pnpm install
pnpm seed:demo     # builds the corpus the gate reasons against (~15s)
pnpm demo          # puts five scenarios through the real gate
pnpm dev           # dashboard at http://localhost:3000
```

`pnpm demo` is re-runnable: it clears the decisions from the previous run so the gate
decides again and narrates every stage. Pass `--keep` to preserve them instead, which is
what production does — a decision row is immutable, and re-deciding an event would
double-spend the token budget and could post a duplicate comment.

`pnpm demo` prints each stage as it happens — which deterministic rules fired, what retrieval found and from which source, the three weighted confidence components, which band rules applied, and every citation:

```
[1/5] Beat 1 — open with a rejection

  EVENT  acme/api#1041   filed by @erin-external, trust=anonymous
  title  Please add a GraphQL endpoint for sessions

  STAGE 1 deterministic policy rules (free, instant, no model)
    no rules fired

  STAGE 2 retrieval before judgement — four sources, unioned
    vector:7  lexical:2  git:2  decision:8   → 19 candidates, ~1648 tokens

  DECISION  REJECT  at confidence 0.88  (human in the loop)
    confidence = 0.5×0.91 self + 0.3×1.00 evidence + 0.2×0.60 policy
    bands applied anonymous_no_autonomous_close

  CITATIONS (every ref verified against what retrieval actually returned)
    doc:adr-0007-no-graphql  [doc]
      "we are not adding a GraphQL layer, decided 2026-06-12"

  no ticket — this is one of the four refusals, which is the point
```

That REJECT is the pitch in one screen. The request is reasonable, the filer is sincere, and building it would contradict a decision the team already made — so the gate declines and *quotes the decision with its date*. Every competitor would have started writing a GraphQL layer.

Run one scenario at a time with `pnpm demo graphql`, or add `--verbose` for the full candidate set. Scenario ids: `graphql` `duplicate` `no-repro` `ambiguous` `real-bug`.

---

## What makes a decision trustworthy

Four properties, each enforced in code rather than requested in a prompt.

### 1. A decision with no evidence is invalid by construction

```ts
citations: z.array(Citation).min(1)
```

The model cannot say "this is a duplicate" without naming what it duplicates, or "already fixed" without pointing at the commit. Zod rejects the tool call and the router retries with the validation error appended — turning a hallucination class into a bounded retry.

### 2. Citations are verified, not trusted

Zod proves citations *exist*. It cannot prove they are *real*: `acme/api#412` is a well-formed string whether or not that issue was ever retrieved. So every cited ref is checked against the candidate set the model was actually given. A fabricated ref forces `ESCALATE`.

### 3. Confidence is recomputed server-side

```
confidence = 0.5 × model_self_report
           + 0.3 × evidence_strength    // best citation similarity, calibrated
           + 0.2 × policy_agreement     // do the deterministic rules concur?
```

The model's self-report is one of three inputs and never the final number, so a model cannot talk its way into autonomy. All three components are stored per decision, so calibration is auditable after the fact.

| Band | Action |
|---|---|
| ≥ 0.80 | act autonomously |
| 0.55 – 0.79 | act, but flag `needs_review` for one-click overturn |
| < 0.55 | **ESCALATE** — no autonomous action |

Thresholds live in a `config` table, not in code, so they can be changed live from the Policy view without a deploy.

### 4. A refusal with no evidence is impossible

`REJECT` or `MERGE` with an empty candidate set is rewritten to `ESCALATE`. With nothing to compare against, a refusal is a guess. This is the one place the system overrides the model on *process* rather than on confidence.

---

## Deterministic first, model second

Cheap checks run before any LLM call. They are free, instant, and catch the majority of real noise:

| Rule | Fires when | Outcome |
|---|---|---|
| `exact_dupe` | title+body hash matches an open item | MERGE |
| `bot_author` | author is a bot / CI account | REJECT |
| `empty_body` | body < 20 chars, no attachment, no stack trace | DEFER |
| `template_unfilled` | issue template placeholders still present | DEFER |
| `already_closed_ref` | references an issue closed in the last 14 days | ESCALATE |
| `spam_signature` | link-only body, known spam patterns | REJECT |

When a rule is decisive **the LLM is never called** — the outcome is mechanical, its evidence is a rule name, and the token cost is zero. That is both a cost story and an accuracy story.

## Retrieval before judgement

The Triage agent never sees a bare issue. It sees the issue plus a candidate set assembled deterministically, so its job is *comparison* rather than recall:

1. **Vector neighbours** — top-8 by cosine over `embeddings` (pgvector, HNSW)
2. **Lexical neighbours** — top-8 by Postgres `ts_rank`; catches exact error strings and identifiers that embeddings blur
3. **Recent git activity** — merged PRs from the last 21 days whose touched paths overlap the issue's extracted symbols. This is what powers *"already fixed on `main`"*
4. **Decision memory** — prior decisions within cosine 0.15, so a re-filed rejected issue is rejected *consistently* and cites its own prior rejection

A source that fails degrades to `[]` and is named in `degraded` — it never throws. Less evidence means lower confidence, which routes the event to a human. That is the correct failure mode.

---

## Architecture

TypeScript end to end. One type system shared between the web app, the workflow definitions and the agent schemas.

```
apps/web/          Next.js 15 — dashboard, webhooks, API      (4 views, 2 routes)
packages/
  core/            domain types, Zod schemas, prompts — pure, no I/O   (12 files)
  db/              Drizzle schema, 10 tables, pgvector helpers         (23 files)
  router/          LLM cascade: budget, retries, schema repair          (7 files)
  agents/          all 8 agents, each a pure fn (ctx) => output         (7 files)
  connectors/      GitHub (built); Linear/Slack/Google planned          (5 files)
  sandbox/         E2B, GitHub Actions and local drivers                (7 files)
  workflows/       Inngest functions — the ONLY layer that does I/O    (13 files)
scripts/           seed + demo runner + offline model
```

**The rule that keeps this buildable: every agent is a pure function.** It takes a context object and returns a typed result. No agent talks to GitHub, Linear or the database directly — only the workflow layer does I/O. That is why all eight agents are unit-testable with no network, and why the whole pipeline is replayable from stored rows.

It is also the seam that lets the entire system run offline: swapping one injected `complete()` function reaches all eight agents without touching any of them.

### The eight agents

| # | Agent | Input | Output |
|---|---|---|---|
| 1 | Orchestrator | normalized event | routing decision, budget |
| 2 | **Triage** | event + retrieved neighbours | one of 5 decisions + confidence + citations |
| 3 | Research | accepted ticket | repo map, relevant files, prior decisions |
| 4 | Planner | ticket + research | ordered change plan, files, risks |
| 5 | Coder | plan + file contents | unified diff |
| 6 | Reviewer | diff + plan | verdict + line comments with severities |
| 7 | QA | diff + sandbox result | pass/fail, failing output, root-cause guess |
| 8 | Delivery | approved diff | PR body, state transition, summary |

Delivery makes **no model call at all**. The PR body's *Why* section is the triage reasoning verbatim, because it is the audit trail and a model asked to write it would paraphrase.

### Stack

| Concern | Choice | Why |
|---|---|---|
| App + dashboard | Next.js on Vercel | free tier; API routes double as webhook receivers |
| Durable execution | Inngest | Temporal Cloud has no free tier |
| Database | Neon Postgres + pgvector | pgvector on every plan; scale-to-zero |
| Offline database | **PGlite** | real Postgres in WASM, in-process, no daemon |
| Sandbox | E2B → GitHub Actions → local | Firecracker isolation, degrades rather than breaks |
| LLM | Groq → Gemini → OpenRouter cascade | all free tiers |
| Validation | Zod | one schema validates LLM output *and* HTTP bodies |
| Observability | own `agent_events` table | Inngest free retains traces 24h; ours is permanent |

---

## Running it for real

Everything above runs with zero credentials. Adding keys upgrades specific parts:

| Env var | Effect |
|---|---|
| `ASCENDANT_LIVE=1` | **use real inference at all.** A key alone is not enough — see below |
| `GROQ_API_KEY` | the triage rungs (capability 0.95). This is the one that matters |
| `GEMINI_API_KEY` | real `text-embedding-004` instead of hashed vectors |
| `OPENROUTER_API_KEY` | a 0.8 overflow rung. Works, but weaker than Groq on triage |
| `DATABASE_URL` | Neon instead of local PGlite |
| `ASCENDANT_LOCAL_DB=1` | use in-process PGlite (**ignored when `DATABASE_URL` is set**) |
| `ASCENDANT_DASHBOARD_PASSWORD` | shared secret for the dashboard gate. A production build **refuses to compile** without it |
| `DEMO_MODE=replay` | Run Detail replays stored traces at their original pacing |

Copy `.env.example` (names only, never values) to `.env` and fill in what you have.

**Live inference is opt-in, and deliberately so.** Setting `ASCENDANT_LIVE=1` without
`GROQ_API_KEY` runs triage on the OpenRouter fallback rung, which is sized for overflow
rather than for the gate: it satisfies the schema but reasons less well, and it loses two
of the five demo beats. A key that made the demo *worse* than no key was the wrong way
round for a credential to fail, so the fixtures stay in charge until asked otherwise.

### Honest about the offline path

Two things are simulated when no keys are set, and both are labelled as such everywhere they surface:

- **The model's reasoning is a fixture**, tagged `fixture:*` in `agent_events.model` and `decisions.model_used`. Everything *around* it is real: the six policy rules, all four retrieval sources, citation validation, the confidence recomputation, banding and the ESCALATE overrides. Only the text is canned — and it is validated through the same Zod schema a real response would be.
- **Embeddings are deterministic hashed term vectors**, not a learned semantic space. They exercise the real pgvector query path — cosine ordering, HNSW, the distance bound — but they are a lexical proxy. The seed output says so.

`DEMO_MODE=replay` serves genuine recorded output at its original timing. Nothing is fabricated; only the pacing between real stored rows is reconstructed.

---

## Development

```bash
pnpm install              # pnpm@9.15.4, pinned
pnpm test                 # 388 tests
pnpm -r typecheck         # 9 workspace projects
pnpm --filter @ascendant/web build
```

A passing typecheck is **not** sufficient before deploying — webpack resolves module paths differently from `tsc`, and several real bugs here were invisible to both until the code actually ran.

<details>
<summary><strong>Test coverage</strong> — 388 tests across 21 files</summary>

| Suite | Tests |
|---|---|
| core: policy / confidence / candidates / normalize / prompt / diff / extract | 24 / 20 / 17 / 22 / 19 / 29 / 10 |
| db: retrieval against real Postgres | 18 |
| router: cascade, repair, budget, guard | 34 |
| agents: triage / pipeline / delivery | 18 / 19 / 26 |
| sandbox: guards + local driver | 33 |
| workflows: applyDiff + repo client | 16 |
| connectors: github | 22 |
| scripts: offline model / embedder / demo mode | 20 / 6 / 6 |
| web: replay schedule / dashboard auth | 10 / 10 |
| core: triage schema tolerance | 3 |

The db suite runs the four retrieval queries against a real Postgres via PGlite. Their correctness lives in SQL — pgvector's `<=>`, `ts_rank`, the jsonb `?|` overlap — all invisible to `tsc`.

</details>

---

## Security

This system reads untrusted text from the internet and then writes code. That is treated as a real threat surface.

**Prompt injection, four layers.** Every ingested body is classified by a prompt-guard model; a hit does not block but caps confidence and forces ESCALATE. Untrusted text never enters the system prompt — it goes in a user-role message inside explicit delimiters, as *data to be analysed*. Writes to `.github/`, CI config, lockfiles and `.env*` are blocked **deterministically**. The Coder's diff is scanned for added network calls, `eval`/`child_process`, new dependencies and credential-shaped strings.

> Layers 1 and 2 reduce the rate; layer 3 bounds the damage. A defence that depends on the model not being fooled is not a defence.

**The sandbox holds no secrets.** Agent-generated code never runs on Vercel, never on your laptop, and never with network access to your own infrastructure. The git push happens *outside* the sandbox, from the workflow, after the diff is read back out.

> The sandbox produces a diff; it never has the credentials to publish one.

**Webhooks are verified before parsing**, with `timingSafeEqual` over the raw body. **No auto-merge, ever** — a human approves every merge.

**The dashboard is gated** by a shared secret in `apps/web/src/middleware.ts`, because `/policy` writes the autonomy threshold that `band()` reads on every decision — an open dashboard is a privilege escalation on the pipeline, not just a data leak. Comparison is over fixed-width SHA-256 digests, so it is length-independent in the Edge runtime, where `node:crypto` is unavailable. The two webhook routes are exempt: they authenticate by HMAC over the raw body, which is stronger than a password, and GitHub cannot send an `Authorization` header at all. A production build **fails** when the secret is unset, which is the moment the dashboard stops being localhost-only.

---

## Status

The gate runs end to end. What is built, and what isn't:

| | |
|---|---|
| ✅ Triage Gate, retrieval, decision object | the thesis, working |
| ✅ Dashboard: Inbox, Run Detail, Metrics, Policy | reading real data |
| ✅ 6 Inngest workflows + LLM router | |
| ✅ 8 agents + 3 sandbox drivers | |
| ✅ Offline path: seed, runner, replay | no keys required |
| ✅ Dashboard auth | shared-secret gate; a production build refuses to compile without it |
| ⬜ GitHub delivery built; Linear + Slack | planned |
| ⬜ Connectors beyond GitHub | planned |
| ⬜ 60-issue labelled eval set | `pnpm eval` is **not written yet** — the 91.7% on Metrics is computed off seeded history, not a labelled set |

### What this deliberately cannot do

- **Multi-repo or large refactors.** `MAX_FILES_TOUCHED = 12`; anything larger ESCALATEs by design. This is a bounded-work system, not an autonomous engineer.
- **Anything without a test signal.** No tests means QA can only lint and typecheck, and confidence is capped so it never auto-acts.
- **UI and visual work.** No screenshot diffing; frontend tickets ESCALATE unless they are pure logic.
- **Architecture decisions.** The Planner refuses plans that add a dependency or change a public API contract, and writes a proposal for a human instead.
- **Replace an engineering team.** It removes triage toil and closes small, well-specified, test-covered tickets. That is a smaller claim than the alternative and a far more defensible one.

---

## Further reading

- **[`PLAN.md`](./PLAN.md)** — the full spec: architecture, free-tier economics, edge cases, threat model
- **[`HANDOFF.md`](./HANDOFF.md)** — living status: what is proven, decisions log with the reasoning behind each, open blockers

The decisions log is worth reading before changing anything. It records choices a future contributor could plausibly reverse by accident — including four bugs that a clean typecheck and 309 passing tests could not catch, three of which failed *silently*.
