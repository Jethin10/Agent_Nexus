# Ascendant — Build Plan

Track 07 (Open Innovation). Judged on **originality, feasibility, real-world impact**, with
bonus credit for a genuinely novel problem space.

Everything in the architecture diagrams gets built. Nothing is cut. What changes versus the
original framing is **which part leads** — see §1.

---

## 1. Positioning (read this first, it changes nothing about the code)

**Do not pitch:** "AI agents that replace your engineering team."
That competes head-on with Devin, OpenHands, Copilot Workspace, Factory, Codegen, Sweep,
Charlie. Judges will ask "why is this better than Devin?" and you lose on the answer.

**Pitch instead:** **the layer that decides what your team should build, then builds it.**

Every coding agent on the market starts from the assumption that *the ticket is valid*. They
begin at "implement this." The expensive failure in real engineering orgs is upstream of that:
duplicate tickets, tickets that contradict a decision made in a meeting three weeks ago,
tickets that are user error, tickets that are already fixed on `main`, tickets that are one
line in a Slack thread and shouldn't be tickets at all.

Ascendant's **Triage Gate** is the product. It reads every event source, decides whether the
work is real, and only then spins up the build pipeline. The multi-agent debate, coding, review,
QA, and delivery are all still there — they are the *body*. The gate is the *thesis*.

Concrete consequences (these are the only three things this repositioning costs you):

1. The demo **opens with a rejection**, not a fix. See §16.
2. The triage decision is a first-class, persisted, auditable object with a confidence score
   and a citation list. See §5.
3. The learning loop reports **one real number about triage quality**. See §11.

Name: **Ascendant**. Subtitle for the slide: *"Decides what to build. Then builds it."*

---

## 2. System architecture

Six layers. Each is a directory in the monorepo.

```
Event Sources ──► Normalizer ──► TRIAGE GATE ──► Work Pipeline ──► Delivery ──► Learning Loop
  (§7)              (§7.3)          (§5)            (§4)            (§8)         (§11)
                                      │
                                      ├─► REJECT  (comment + close, with reasoning)
                                      ├─► MERGE   (link as duplicate of existing ticket)
                                      ├─► DEFER   (needs info → ask the human, wait)
                                      ├─► ESCALATE(low confidence → human decides)
                                      └─► ACCEPT  (→ Linear ticket → pipeline)
```

A decision is never "yes/no". It is one of five outcomes, always with reasoning and citations.
The four non-ACCEPT paths are what nobody else ships.

---

## 3. Stack and repo layout

TypeScript end to end. One language means one type system shared between the web app, the
workflow definitions, and the agent tool schemas — that matters more than picking the "best"
language per layer when you are building this in a hackathon window.

| Concern | Choice | Why |
|---|---|---|
| App + API + dashboard | Next.js on Vercel | Free Hobby tier, zero-config deploys, API routes double as webhook receivers |
| Durable execution | **Inngest** (not Temporal) | Temporal Cloud has no free tier; see §6 |
| Database | Neon Postgres + pgvector | pgvector on every plan incl. Free; scale-to-zero |
| Code execution sandbox | E2B (primary), GitHub Actions (fallback) | Firecracker isolation; see §12.4 |
| LLM inference | Groq → Gemini → OpenRouter `:free` cascade | See §10 |
| Queue/cache | Postgres tables (no Redis) | One fewer service to keep free |
| Schema/validation | Zod | Same schema validates LLM tool output and HTTP bodies |
| ORM | Drizzle | Typed SQL, works with Neon serverless driver |
| Observability | Inngest traces + own `agent_events` table | Inngest free retention is 24h; ours is permanent |

```
ascendant/
├─ apps/
│  └─ web/                  Next.js: dashboard, webhooks, API, agent-console UI
├─ packages/
│  ├─ core/                 domain types, Zod schemas, prompt templates
│  ├─ db/                   Drizzle schema + migrations + pgvector helpers
│  ├─ router/               LLM router: cascade, budget, retries, injection scan
│  ├─ agents/               all seven agents, each a pure fn (ctx) => output
│  ├─ workflows/            Inngest function definitions
│  ├─ connectors/           github, linear, slack, gmail, gcal, gdrive, granola
│  └─ sandbox/              E2B + Actions drivers behind one interface
├─ scripts/
│  ├─ seed-demo.ts          loads the demo fixtures (§16)
│  └─ eval.ts               runs the triage eval set (§11)
└─ PLAN.md
```

Rule that keeps this buildable: **every agent is a pure function.** It takes a context object,
returns a typed result. No agent talks to Linear, GitHub, or the database directly. Only the
workflow layer does I/O. This makes all seven agents unit-testable without network access and
makes the whole pipeline replayable from stored inputs.

---

## 4. The work pipeline (all seven agents)

### 4.1 The seven agents

| # | Agent | Input | Output | Model tier |
|---|---|---|---|---|
| 1 | **Orchestrator** | normalized event | routing decision, budget | cheap (8b) |
| 2 | **Triage** | event + retrieved neighbours | one of 5 decisions + confidence + citations | strong (70b) |
| 3 | **Research** | accepted ticket | repo map, relevant files, prior decisions | strong |
| 4 | **Planner** | ticket + research | ordered change plan, files to touch, risks | strong |
| 5 | **Coder** | plan + file contents | unified diff | strongest available |
| 6 | **Reviewer** | diff + plan + conventions | verdict + line comments + severity | strong |
| 7 | **QA** | diff + sandbox result | pass/fail, failing test output, root-cause guess | strong |
| — | **Delivery** | approved diff | PR body, Linear transition, Slack summary | cheap |

Delivery is deliberately not "intelligent" — it is templating plus API calls. Eight boxes in the
diagram, seven of them reasoning.

### 4.2 The discussion loop, built to survive a 5-concurrency cap

The diagram says "agents argue with each other." Naive implementation = wide fan-out of parallel
agents. On Inngest Hobby that is fatal: **5 concurrent executions, and every step counts as an
execution** (a run with 5 steps burns 6). Fan-out of 6 debate agents × 3 rounds = 18+ executions
per ticket and immediate queueing.

So the debate is **sequential and bounded**, which is also better output:

```
round 1   Planner  proposes plan
          Reviewer critiques plan          ─┐
          Planner  revises or defends       ├─ 1 Inngest step
                                           ─┘   (loop runs inside step.run)
round 2   Coder    writes diff
          Reviewer critiques diff
          Coder    revises                  ─ 1 Inngest step
round 3   QA       runs tests in sandbox    ─ 1 Inngest step
          if fail → Coder gets the failure  ─ 1 Inngest step (max 2 retries)
```

Each *round* is one `step.run()`; the multi-turn argument happens as a plain `for` loop of LLM
calls **inside** that step. Inngest sees ~6 steps per ticket, not 20. Cost: if the process
crashes mid-round, that round replays from its start — acceptable, rounds are 30-90s.

Hard caps, enforced in code not prompts:
- `MAX_DEBATE_ROUNDS = 3`
- `MAX_CODER_RETRIES = 2`
- `MAX_FILES_TOUCHED = 12` (Planner rejects its own plan above this → ESCALATE)
- `MAX_DIFF_LINES = 400` (same)
- per-ticket token budget, checked before every call (§10.4)

Any cap hit is not a crash. It is an **ESCALATE** with the transcript attached. The system's
failure mode is always "hand it to a human with everything we learned," never "silently produce
garbage."

### 4.3 Workflow shape (Inngest)

Five functions, not one. Splitting on the natural wait points keeps any single run's state well
under Inngest's 32 MB run-state ceiling and lets a stalled ticket sit in a DEFER wait without
holding a concurrency slot.

| Function | Trigger | Ends by |
|---|---|---|
| `ingest` | `event/received` | writing `events` row, emitting `triage/requested` |
| `triage` | `triage/requested` | persisting a `decisions` row, emitting `work/accepted` only on ACCEPT |
| `plan-and-code` | `work/accepted` | emitting `review/ready` with a diff id |
| `qa` | `review/ready` | emitting `delivery/ready` or looping back once |
| `deliver` | `delivery/ready` | PR opened, Linear moved, `outcomes` row seeded |

Never pass blobs through events. Inngest's free event payload cap is **256 KiB** and step return
values cap at 4 MB. Diffs, file contents, and transcripts go to Postgres; events carry only IDs.
This one rule is why the system does not fall over on a large ticket.

DEFER and ESCALATE both use `step.waitForEvent` with a **72-hour** timeout (free tier allows
sleeps up to 7 days). Timeout → auto-close with a comment. No orphaned tickets, ever.

---

## 5. The Triage Gate (the thesis)

### 5.1 The decision object

Persisted, immutable, one row per decision. This is the artifact you put on screen in the demo.

```ts
// packages/core/src/triage.ts
export const TriageDecision = z.object({
  eventId:    z.string().uuid(),
  outcome:    z.enum(['ACCEPT','REJECT','MERGE','DEFER','ESCALATE']),
  confidence: z.number().min(0).max(1),
  reasoning:  z.string().min(40).max(1200),   // human-readable, goes in the comment
  citations:  z.array(z.object({
    kind:   z.enum(['issue','pr','commit','doc','message','meeting','ticket']),
    ref:    z.string(),        // URL or stable id
    quote:  z.string().max(400),
    why:    z.string().max(200),
  })).min(1),                  // ← a decision with no evidence is invalid by construction
  mergeTargetId: z.string().optional(),   // required when outcome === 'MERGE'
  missingInfo:   z.array(z.string()).optional(),  // required when outcome === 'DEFER'
  policyHits:    z.array(z.string()),     // deterministic rules that fired
  modelUsed:     z.string(),
  latencyMs:     z.number(),
})
```

`citations.min(1)` is the whole design in one line. The model cannot say "this is a duplicate"
without naming what it duplicates, and it cannot say "already fixed" without pointing at the
commit. Zod rejects the tool call and the router retries with the validation error appended.
That converts the classic hallucination failure into a bounded retry.

### 5.2 Two stages: deterministic first, model second

Cheap checks run before any LLM call. They are free, instant, and catch the majority of real
noise:

| Rule | Fires | Outcome |
|---|---|---|
| `exact_dupe` | title+body hash matches an open item | MERGE |
| `bot_author` | author is a bot / CI account | REJECT |
| `empty_body` | body < 20 chars, no attachment, no stack trace | DEFER |
| `template_unfilled` | issue template placeholders still present | DEFER |
| `already_closed_ref` | references an issue closed in last 14 days | ESCALATE |
| `spam_signature` | link-only body, known spam patterns | REJECT |

Every rule that fires lands in `policyHits`. If a rule produces a confident outcome, **the LLM is
never called** — which is both a cost story and an accuracy story you can say out loud.

### 5.3 Retrieval before judgement

The Triage agent never sees a bare issue. It sees the issue plus a **candidate set** assembled
deterministically, so its job is comparison rather than recall:

1. **Vector neighbours** — top 8 by cosine over `embeddings` (open + recently closed issues,
   tickets, meeting notes, decision docs). pgvector, one query.
2. **Lexical neighbours** — top 8 by Postgres `ts_rank` on the same corpus. Catches exact error
   strings and identifiers that embeddings blur.
3. **Recent git activity** — commits and merged PRs from the last 21 days whose message or
   touched paths overlap the issue's extracted symbols. This is what powers "already fixed on
   `main`."
4. **Decision memory** — any `decisions` row within cosine 0.15 of this event, so a re-filed
   rejected issue gets rejected consistently and *cites its own prior rejection*.

Union, dedupe, cap at 20 candidates, ~6k tokens. Well inside the 12k TPM ceiling on
`llama-3.3-70b-versatile`.

Item 4 is the sneaky-good one. It gives the system a memory of its own judgements, which is what
makes repeated ESCALATE-then-human-decides interactions compound into policy (§11.3).

### 5.4 Confidence and the escalation band

Confidence is not the model's self-report alone. It is:

```
confidence = 0.5 * model_self_report
           + 0.3 * evidence_strength      // best citation similarity, calibrated
           + 0.2 * policy_agreement       // do deterministic rules concur?
```

| Band | Action |
|---|---|
| ≥ 0.80 | act autonomously (comment, close, merge, or open ticket) |
| 0.55 – 0.79 | act, but flag `needs_review` and post the reasoning for a human to overturn in one click |
| < 0.55 | **ESCALATE** — no autonomous action, human decides |

Thresholds live in a config table, not in code, so you can move them live during the demo and
show the behaviour change. Overturns are recorded (§11.3) — that is the learning signal.

### 5.5 The reject comment

Non-obvious product detail: a rejection must not read like a bot dismissing someone. Template:

> **Ascendant triaged this as a duplicate** (confidence 0.91).
> This looks like the same failure as #412, which is open and assigned. Evidence: both report
> `TypeError: cannot read 'id' of undefined` from `apps/api/src/session.ts:88`, and both start
> after `v2.3.1`.
> I've linked them. If this is actually different, reply `/ascendant reopen` and I'll route it
> to a human immediately.

Every autonomous action ships with a one-command undo. That is the difference between a system an
engineering org would actually install and a party trick.

---

## 6. Why Inngest and not Temporal

Both are correct choices architecturally. The decision is purely economic.

**Temporal Cloud has no permanently free tier.** $1,000 in trial credits, **credit card required
at signup**, and the cheapest ongoing plan (Essentials) starts at **$100/month** for 1M Actions,
1 GB Active Storage, 40 GB Retained Storage. The startups program grants $6,000 for companies
under $30M funding — irrelevant to a hackathon team. Self-hosting the open-source Temporal
Service is genuinely free but means running the server, a database, and the UI somewhere, and
that "somewhere" is not free either.

**Inngest Hobby is free forever, no card**, and is a better fit for serverless functions on
Vercel because the workflow *is* the HTTP handler — no worker process to keep alive.

What you accept in exchange (all designed around in §4.2 and §4.3):

| Limit | Value | Mitigation |
|---|---|---|
| Executions | 50k/month, **run + each step counts** | ~6 steps/ticket → ~7 executions → ≈7,000 tickets/month |
| Concurrency | **5 concurrent** | sequential debate, no wide fan-out |
| Event payload | 256 KiB | IDs only, blobs in Postgres |
| Step return | 4 MB | same |
| Total run state | 32 MB | five functions instead of one |
| Trace/log retention | **24 hours** | own `agent_events` table = permanent history |
| Sleep | up to 7 days | DEFER waits capped at 72h |
| Retries | count as extra runs | retry budget per ticket, capped |
| Metrics granularity | 30 min | own metrics from Postgres |

The 24-hour retention point deserves emphasis: **you cannot rely on Inngest's dashboard for the
demo.** If you built the run on Friday and demo on Sunday, the traces are gone. Every step writes
to `agent_events` with a monotonic sequence number, and the dashboard in §11.1 reads that. Side
benefit: the judges see *your* UI, not a vendor's.

Escape hatch, worth one line on the slide: because every agent is a pure function and the
workflow layer is thin, porting to Temporal is a rewrite of `packages/workflows` only — roughly
400 lines. Say that when someone asks whether this scales past 50k executions.

---

## 7. Event sources and the Normalizer

All six sources from the diagram get built. They differ only in how the raw payload arrives.

### 7.1 The six connectors

| Source | Mechanism | Auth | Rate ceiling | Notes |
|---|---|---|---|---|
| **GitHub Issues/PRs** | GitHub App webhook | installation token | **5,000 req/hr** floor, +50/hr per repo past 20, hard cap 12,500 | webhook, never poll |
| **Linear** | webhook in, GraphQL out | OAuth app | 5,000 req/hr (OAuth), 2M complexity/hr | docs "especially discourage" polling |
| **Slack / Teams** | Events API + `/ascendant` slash command | bot token | Tier-based, ~1 msg/s posting | reaction emoji = a triage vote |
| **Gmail** | Pub/Sub push via `users.watch` | OAuth, `gmail.readonly` | 1.2M quota units/min/user | watch expires in 7 days — renew daily by cron |
| **Google Calendar** | push channel + `events.list` | OAuth, `calendar.readonly` | 1M queries/day default | supplies meeting metadata for Granola notes |
| **Google Drive** | `changes.watch` push channel | OAuth, `drive.readonly` | 12,000 queries/min | design docs, PRDs → decision memory |
| **Granola** | no public API → notes exported to a watched Drive folder, or paste-in via dashboard | — | — | see §13.7, this is the one honest gap |

Every connector implements the same interface, which is what keeps seven integrations from
becoming seven codebases:

```ts
export interface Connector {
  id: SourceId
  verify(req: Request): Promise<boolean>          // signature check, per §15.2
  parse(raw: unknown): Promise<RawEvent[]>        // 1 payload → n events
  hydrate?(e: RawEvent): Promise<RawEvent>        // fetch thread/parents if needed
  respond?(action: OutboundAction): Promise<void> // comment, close, react, reply
}
```

### 7.2 Ingestion is webhook-first, with one cron

Polling burns free-tier quota for nothing and Linear explicitly discourages it. Everything is
push. The single scheduled job is a **daily 05:00 UTC maintenance cron** that renews Gmail
`users.watch` and Drive `changes.watch` channels (both expire in ≤7 days), re-embeds anything
whose embedding is missing, and rolls up yesterday's metrics. One cron, well inside Vercel's 100
and Cloudflare's 5.

### 7.3 The Normalizer

Six sources, one internal shape. Everything downstream — retrieval, triage, the dashboard —
speaks only this type. Adding a seventh source later touches one file.

```ts
export const NormalizedEvent = z.object({
  id:        z.string().uuid(),
  source:    z.enum(['github','linear','slack','gmail','gcal','gdrive','granola']),
  sourceRef: z.string(),          // stable upstream id, used for idempotency
  kind:      z.enum(['issue','pr','comment','message','email','meeting_note','doc','command']),
  threadKey: z.string().nullable(),  // groups a conversation into one unit of work
  actor:     z.object({ id: z.string(), handle: z.string(), isBot: z.boolean() }),
  title:     z.string(),
  body:      z.string(),          // markdown, already stripped of quoted replies
  createdAt: z.coerce.date(),
  attachments: z.array(z.object({ name: z.string(), url: z.string(), mime: z.string() })),
  extracted: z.object({           // deterministic, no LLM — this is what makes retrieval good
    symbols:    z.array(z.string()),   // identifiers, file paths, function names
    versions:   z.array(z.string()),   // v2.3.1, commit shas
    stackFrames: z.array(z.string()),
    urls:       z.array(z.string()),
    issueRefs:  z.array(z.string()),   // #412, ENG-88
  }),
  trust: z.enum(['internal','known_external','anonymous']),  // drives §15.3
  raw:   z.unknown(),             // kept verbatim for replay
})
```

Three properties worth defending in the write-up:

**Idempotency.** `UNIQUE (source, sourceRef, contentHash)`. Webhooks retry; GitHub redelivers;
Pub/Sub is at-least-once. A redelivery finds the row, returns the existing event id, and does not
re-trigger triage. Costs one index, removes an entire class of demo-day embarrassment.

**Thread collapsing.** A Slack thread with 14 replies is *one* event, not 14. `threadKey` groups
them and the body is the reconstructed conversation. Without this, the system would triage the
same problem a dozen times and the whole cost model breaks.

**`extracted` is regex, not LLM.** Symbols, versions, stack frames, and issue refs are pulled with
deterministic parsers. Free, instant, and better than a model at exact string capture — and they
are the join keys for §5.3's lexical and git-activity retrieval.

`trust` is set here because it is the only place that knows the provenance. An anonymous GitHub
issue from a first-time author and an email from the CTO get the same *pipeline* but different
*privileges* (§15.3).

---

## 8. Delivery

The pipeline's output is never a silent commit. It is always a **reviewable artifact plus a state
change plus a notification**, and all three are idempotent.

### 8.1 GitHub

Branch `ascendant/<linear-id>-<slug>`, never `main`. The diff is applied in the sandbox, committed
with a trailer, and pushed via the installation token.

```
Fix session id crash on expired token (ENG-142)

Co-Authored-By: Ascendant <ascendant@users.noreply.github.com>
Ascendant-Decision: <decision-uuid>
Ascendant-Confidence: 0.87
```

`Ascendant-Decision` is the audit link — from any commit in history you can retrieve the exact
event, retrieval set, debate transcript, and review verdict that produced it. Nobody else's coding
agent gives you that, and it costs one git trailer.

The PR body is generated from a template, not free-form prose:

- **What changed** — one paragraph, plus the file list with a one-line reason each
- **Why** — the triage decision's reasoning, verbatim, with citations as links
- **Debate summary** — Reviewer's objections and how the Coder answered (collapsed `<details>`)
- **Tests** — commands run, output, coverage delta if available
- **Risk** — what the Planner flagged, and what it did *not* verify
- **Undo** — `/ascendant revert` closes the PR and deletes the branch

PRs are opened as **draft** when confidence < 0.80, ready-for-review above it. Never auto-merged.
Auto-merge is one config flag away and deliberately left off — say that out loud, it reads as
judgement rather than a missing feature.

### 8.2 Linear

The ticket is created at ACCEPT, not at delivery, so the work is visible while it runs. State
transitions are driven by workflow events, mirroring the pipeline stages: `Triage → Todo → In
Progress → In Review → Done`. The Ascendant decision id goes in a custom field; the PR is attached
via Linear's GitHub integration so the ticket auto-closes on merge.

Cost control matters here. Linear bills **complexity**, capped at 10,000 points per single query,
and quotas attach to the authenticated user. So: mutations only for state changes, explicit `first:`
on every connection (never rely on the default 50), and one cached workspace-metadata fetch per
day rather than resolving team/state/label IDs on every call. Rate-limit responses arrive as
**HTTP 400 with `RATELIMITED`** in the errors array, not 429 — the connector checks the error body,
not just the status code. That single detail is where naive Linear integrations break.

### 8.3 Slack

One threaded message per ticket, updated in place via `chat.update` rather than a new message per
stage. Buttons: **Approve**, **Escalate to me**, **Reject decision**. Button clicks emit the events
that `waitForEvent` is blocked on in §4.3, which is how a human unblocks a DEFER without opening
the dashboard. Emoji reactions on the original message work as a lightweight vote.

---

## 9. Data model and the context store

Ten tables. Drizzle schema in `packages/db`. Everything the system knows lives here, which is what
makes the whole pipeline replayable and the dashboard permanent despite Inngest's 24h retention.

| Table | Holds | Why it exists |
|---|---|---|
| `events` | normalized events + `raw` | replay, idempotency |
| `decisions` | §5.1 triage decision objects | the product's audit trail |
| `tickets` | Linear mirror (id, state, links) | avoid re-querying Linear |
| `runs` | one row per pipeline execution | cycle time, status |
| `agent_events` | every agent call: prompt hash, model, tokens, latency, output | permanent trace, cost accounting |
| `artifacts` | diffs, transcripts, test output, PR bodies | keeps events under 256 KiB |
| `embeddings` | `vector(768)` + source ref + chunk | retrieval (§5.3) |
| `outcomes` | PR merged/closed, review comments, reverts | learning signal (§11) |
| `overturns` | human disagreed with a decision + corrected label | the eval set grows itself |
| `config` | thresholds, budgets, feature flags | tune live during the demo |

### 9.1 Embeddings on a free budget

Model: **`text-embedding-004`** via Gemini (free tier), 768 dimensions. Fallback: `bge-small-en`
running locally in the sandbox if the quota is exhausted — 384 dims, stored in a second column so
the two never get compared.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE embeddings ADD COLUMN vec vector(768);
CREATE INDEX ON embeddings USING hnsw (vec vector_cosine_ops);
```

HNSW over IVFFlat: no training step, better recall at this corpus size, and it works from the first
inserted row — which matters when the demo seed script populates the table seconds before you
present.

Chunking: issues and messages are embedded whole (they are short). Docs are chunked at ~800 tokens
with 100 overlap, headings prepended to each chunk so a chunk retains its context.

**Storage sanity check against Neon Free's 0.5 GB:** a 768-dim `vector` is ~3 KB with overhead, plus
~2 KB of text per row. 10,000 embedded items ≈ 50 MB. The corpus is not the constraint; the `raw`
column on `events` is. Raw payloads are truncated to 64 KB and anything larger is dropped after 30
days by the maintenance cron.

---

## 10. The LLM router

`packages/router` is one function with a hard contract: given a task class and a Zod schema, return
validated typed output or throw a typed error. Every agent calls only this. No agent knows which
provider served it.

```ts
export async function complete<T>(opts: {
  task: 'triage'|'plan'|'code'|'review'|'qa'|'summarize'|'classify'
  schema: z.ZodType<T>
  system: string
  messages: Message[]
  ticketId?: string          // for budget accounting
}): Promise<{ value: T; model: string; tokens: number; latencyMs: number }>
```

### 10.1 The cascade

Ladder per task class, tried in order. Real numbers from the providers' published free tiers:

| Tier | Provider / model | Free ceiling | Used for |
|---|---|---|---|
| 1 | Groq `llama-3.3-70b-versatile` | 30 RPM / 1K RPD / 12K TPM / 100K TPD | triage, plan, review, qa |
| 2 | Groq `openai/gpt-oss-120b` | 30 RPM / 1K RPD / 8K TPM / 200K TPD | same, on 429 or TPM squeeze |
| 3 | Gemini `2.5-flash` | per-project, see §13.4 | overflow; large context |
| 4 | OpenRouter `<model>:free` | 20 RPM / 50 RPD (1,000 RPD after $10 lifetime) | last resort |
| 5 | Cerebras | $5 one-time credits | burst during the demo only |
| — | Groq `llama-3.1-8b-instant` | 30 RPM / 14.4K RPD / 6K TPM / 500K TPD | orchestrator, delivery, cheap classification |
| — | Groq `llama-prompt-guard-2-86m` | 30 RPM / 14.4K RPD / 500K TPD | injection scan on every ingested body (§15.3) |

Coding gets the strongest model available; if every tier is exhausted the ticket does not fail, it
**ESCALATEs with `reason: 'no_capacity'`**. Degradation is a first-class outcome, never a crash.

Groq's limits are **per organization, not per key** — a second key buys nothing. OpenRouter is the
same, governed globally per account. What *does* buy headroom is spreading across *models*, since
limits are per-model. The router exploits exactly that, and it is the reason the ladder lists
sibling models on the same provider before changing provider.

### 10.2 Choosing a rung

Not round-robin. The router keeps a live per-model state row (`config` table, 5-second cache):

```
score = available(model)          // not in cooldown from a 429
      × fits(estimatedTokens, tpmRemaining)
      × capability(task, model)   // static table
      / expectedLatencyMs
```

429 responses put a model in cooldown until `X-RateLimit-Reset` (Groq and OpenRouter both send
reset headers on 429, though not on success — so remaining-quota tracking is estimated locally from
counted usage, not read from headers). OpenRouter additionally exposes
`GET /api/v1/key` returning `limit_remaining` and `is_free_tier`; the maintenance cron reads it
once a day to correct drift.

### 10.3 Schema enforcement and repair

Every call requests JSON against a Zod schema. On validation failure: one retry with the Zod error
appended to the messages, then escalate the *rung*, not the ticket. Two schema failures on the same
model is treated as a capability signal and downgrades that model's `capability(task, model)` score
for the rest of the run. This is why triage citations (§5.1) are reliable rather than aspirational.

### 10.4 Budget

Per-ticket ceiling in the `config` table: default **60,000 tokens** and **25 LLM calls**. Checked
before every call, decremented after. Exceeding it is an ESCALATE with the transcript, never a
half-finished PR. A per-day org ceiling (default 400k tokens) protects the RPD limits so a runaway
loop at 2am cannot leave you with a dead demo at 10am. Both are visible on the dashboard — judges
like seeing a system that knows what it spends.

---

## 11. Learning loop and metrics

The diagram's "Closed Feedback Loop" is usually the part teams fake. Here it is three concrete
mechanisms, each producing a number you can put on screen.

### 11.1 The dashboard (reads Postgres, not Inngest)

Four views in `apps/web`:

- **Inbox** — every event with its decision, outcome badge, and confidence. Filterable by outcome.
  Click a row → the full decision object, citations as links, and the debate transcript.
- **Run detail** — the pipeline as a timeline from `agent_events`: which agent, which model, tokens,
  latency, what it said. This is the "agents arguing" view, rendered as a structured diff-and-comment
  thread rather than a wall of scrolling text (§16 depends on this).
- **Metrics** — the four from the diagram: velocity, cycle time, completion/delivery rate, workload
  insights. Plus triage precision (§11.2).
- **Policy** — the thresholds and budgets from `config`, editable live.

Because it reads your own tables, history is permanent and the demo works offline from a seeded DB.

### 11.2 The one real number

**Triage precision: of the decisions Ascendant made autonomously, what fraction did a human leave
standing?**

```
precision = 1 − (overturns / autonomous_decisions)
```

Measured over a labelled eval set of **60 events** in `scripts/eval.ts` — real GitHub issues from
public repos, hand-labelled with the correct one of the five outcomes, including the hard cases: a
duplicate phrased differently, an issue already fixed on `main`, a feature request contradicting a
documented decision, a user-error report, a genuine bug. Reported as a confusion matrix over the
five outcomes, not a single accuracy figure — because REJECTing something that should have been
ACCEPTed is a much worse error than the reverse, and the matrix shows you take that seriously.

`pnpm eval` prints the matrix and writes it to `evals/results-<date>.json`. Run it before the demo,
put the matrix on the slide. **A number from a real eval set is the single highest-leverage thing in
this submission** — it is what separates "we built agents" from "we measured whether they were
right."

### 11.3 How the loop actually closes

Three feedback signals, each with a defined mutation:

| Signal | Recorded as | Effect |
|---|---|---|
| Human overturns a decision | `overturns` row with corrected label | added to the eval set; the corrected pair is retrieved as a **few-shot example** for similar future events (§5.3 item 4) |
| PR merged / closed unmerged / reverted | `outcomes` row | per-repo delivery rate; three closures on a file pattern raises `MAX_FILES_TOUCHED` sensitivity and lowers autonomy for that area |
| Reviewer objection repeated ≥3× | mined nightly from `agent_events` | promoted into the repo's convention block in the Coder's system prompt |

None of this is model fine-tuning — it is retrieval, prompt, and threshold mutation, all of which are
free and all of which are observable in the dashboard. When a judge asks "does it actually learn?",
the answer is a specific table and a specific mutation, not a gesture at the arrow in the diagram.

---

## 12. Hosting topology and what it costs

### 12.1 The map

```
GitHub / Linear / Slack / Google  ──webhook──►  Vercel (Next.js API routes)
                                                    │ verify sig, normalize, insert
                                                    ▼
                                              Inngest (durable steps)
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                              Groq/Gemini/       Neon PG        E2B sandbox
                              OpenRouter        + pgvector      (git, tests)
                                    │               │               │
                                    └───────────────┴───────────────┘
                                                    ▼
                                        GitHub PR · Linear · Slack
```

Six services. Every one has a permanent free tier or recurring free credit. No credit card required
for any of them except optionally OpenRouter (§13.5).

### 12.2 Deploy order (this is the actual setup runbook)

1. **Neon** — create project, run Drizzle migrations, `CREATE EXTENSION vector`. Copy the pooled
   connection string.
2. **Vercel** — import repo, add env vars, deploy. **If the repo lives under a GitHub organization,
   Hobby cannot connect to it** (§13.3) — keep the repo under a personal account.
3. **Inngest** — connect the Vercel URL as an app; it discovers functions from `/api/inngest`.
   Copy the signing key and event key into Vercel env.
4. **GitHub App** — create it (not an OAuth app), permissions: Issues R/W, PRs R/W, Contents R/W,
   Metadata R. Subscribe to issues, issue_comment, pull_request, push. Install on the demo repo.
   Store the private key as a base64 env var.
5. **Linear** — OAuth app + webhook to `/api/webhooks/linear`. Create the `Ascendant Decision`
   custom field.
6. **Slack** — app with `chat:write`, `commands`, `reactions:read`, Events API to
   `/api/webhooks/slack`, slash command `/ascendant`.
7. **Google** — one Cloud project, enable Gmail/Calendar/Drive APIs, OAuth consent in testing mode
   (your own account only — fine, and avoids verification), Pub/Sub topic for Gmail push.
8. **E2B** — API key, build the template image once (`e2b template build`) with node, pnpm, git, and
   the demo repo's deps pre-installed. Pre-baking deps is what takes sandbox startup from ~90s to
   ~5s, and it is the difference between a demo that lands and one that doesn't.
9. **Groq / Gemini / OpenRouter** — API keys into Vercel env. Groq first.
10. `pnpm seed:demo` — loads the §16 fixtures.

### 12.3 Cost model at demo scale

Assume the demo repo plus a week of realistic activity: **200 events, 60 accepted, 60 PRs.**

| Service | Consumption | Free allowance | Headroom |
|---|---|---|---|
| Vercel | ~3k invocations, <1 CPU-hr | 1M invocations, 4 CPU-hr | ~99% |
| Inngest | 60 tickets × ~7 = **420 executions** | 50,000/mo | ~99% |
| Neon | ~80 MB, ~15 CU-hr (scale-to-zero) | 0.5 GB, 100 CU-hr | ~85% |
| Groq | ~60 tickets × 25 calls ≈ 1,500 calls | 1,000 RPD on 70b + siblings | **tight — see §13.4** |
| Gemini embeddings | ~10k embeddings | free tier | fine |
| E2B | 60 runs × ~4 min ≈ 4 sandbox-hours | $100 one-time credit | ~weeks of demos |
| GitHub | ~2k API calls | 5,000/hr | ~96% |
| Linear | ~500 calls | 5,000/hr | ~90% |

**Total marginal cost: $0.00.** The binding constraint is not money, it is **Groq's requests-per-day
ceiling** — which is exactly why the router (§10) and the per-day budget (§10.4) exist rather than
being nice-to-haves.

### 12.4 The sandbox layer

Agent-generated code never runs on Vercel, never runs on your laptop, and never runs with network
access to your own infrastructure. Two drivers behind one interface:

```ts
export interface SandboxDriver {
  create(spec: { image: string; timeoutMs: number }): Promise<Handle>
  writeFiles(h: Handle, files: FileMap): Promise<void>
  exec(h: Handle, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
  readFile(h: Handle, path: string): Promise<string>
  destroy(h: Handle): Promise<void>
}
```

**Primary: E2B.** Firecracker microVM per sandbox, so a hostile `rm -rf /` or fork bomb costs you a
container, not a machine. Hobby gives **$100 one-time credits**, billed per second, **20 concurrent
sandboxes**, and a **1-hour max session** — none of which bind here because a QA run is ~4 minutes
and Inngest only allows 5 concurrent steps anyway. Config: 2 vCPU, 2 GB RAM, 10-minute hard timeout.

**Fallback: GitHub Actions** via `workflow_dispatch`, polled for completion. Slower (~2 min queue)
but **free and unlimited on public repositories** with standard runners. Making the demo repo public
is therefore both a cost and a reliability decision. The Actions driver exists so that an E2B outage
or an exhausted credit does not kill the pipeline — it degrades to slower, not broken.

**Considered and rejected: Modal.** $30/month *recurring* credit and 100 containers is a better
long-run deal than E2B's one-time $100, and if this ran past the hackathon that is the switch to
make. It loses here on integration time: E2B's SDK is purpose-built for exactly this filesystem-plus-
exec shape, and the driver interface above means swapping later is a ~150-line file.

Sandbox rules, enforced by the driver not by prompt:
- no secrets mounted — the sandbox gets source code, never a token
- egress allowlist: package registry only; **no access to Neon, Inngest, or the GitHub API**
- the git push happens *outside* the sandbox, from the workflow, after the diff is read back out
- 10-minute wall clock, 512 MB written-file cap, destroyed in a `finally` block

That third rule is the important one. The sandbox produces a diff; it never has the credentials to
publish one. An agent that gets prompt-injected inside the sandbox can at worst write a bad diff
that then has to survive Reviewer, QA, and a human PR review.

---

## 13. Limitations (know these before a judge finds them)

Every one of these is real. Having a crisp answer to each is worth more than pretending they don't
exist — judges probe feasibility, and "we know exactly where this breaks" reads as competence.

### 13.1 Neon suspends compute for the rest of the month

Exceeding **any** Free-plan limit — 0.5 GB storage, 100 CU-hours, or 5 GB egress — suspends compute
until the next billing month. Not throttled. Suspended. That is the single scariest failure mode on
this stack because it would kill a demo dead.

Mitigations: scale-to-zero is on by default (5 min idle, not configurable), autoscale ceiling pinned
low, the maintenance cron reports CU-hours consumed to the dashboard, and — non-negotiable — **a
`pg_dump` of the seeded demo database committed to the repo**, plus a local Postgres+pgvector via
Docker as the offline path. If Neon is suspended at 10am on demo day you flip `DATABASE_URL` to
localhost and lose nothing.

### 13.2 Inngest's free tier caps concurrency at 5 and retains traces for 24 hours

Already designed around: sequential debate (§4.2), five functions (§4.3), and your own
`agent_events` table for permanent history (§6). The remaining honest limitation is **throughput** —
with 5 concurrent executions, a burst of 30 simultaneous issues queues rather than parallelizes.
Latency per ticket stays ~3-5 minutes; the 30th ticket in a burst waits. Correct answer to the
scaling question is the Pro tier at $99/mo for 100+ concurrency, or the ~400-line port to Temporal.

### 13.3 Vercel Hobby: 60-second functions, and no org-owned repos

Function max duration is **60s** (default 10s). Every long operation therefore *must* live in an
Inngest step, which the architecture already assumes — but it means you can never "just await the
agent" in an API route. The webhook handler's only job is verify → insert → emit → 200.

Second trap, easy to trip on hackathon day: **Hobby teams cannot connect to Git repositories owned
by a GitHub organization.** If the team created the repo under an org, Vercel deploys will refuse.
Keep it on a personal account, or deploy via `vercel --prod` from the CLI.

Runtime logs are retained **1 hour** on Hobby. Same answer as Inngest: your own table.

### 13.4 Free LLM tiers are requests-per-day limited, and that is the real ceiling

Groq `llama-3.3-70b-versatile` is **1,000 requests/day, org-wide**. At ~25 calls per ticket that is
**40 tickets/day** on the primary model before the cascade starts shedding to weaker rungs. A heavy
demo rehearsal morning can genuinely exhaust it.

Consequences to state plainly: the router's cascade is load-bearing, not decoration; the per-day
budget (§10.4) exists to stop a rehearsal from eating the live demo; and `llama-3.1-8b-instant` at
14,400 RPD absorbs all the cheap work so the 70b budget goes only to triage, planning, code, and
review.

Gemini is the awkward one: **per-model free RPM/TPM/RPD are not published in the public docs** — they
are only visible in AI Studio while signed in, they are per *project* not per key, they reset at
midnight Pacific, and the docs explicitly say limits "are not guaranteed." So Gemini is used for
embeddings and overflow, never as a rung anything critical depends on.

### 13.5 OpenRouter's free tier needs $10 spent to be useful

Free `:free` models are **20 RPM / 50 requests per day** with under 10 credits purchased all-time,
rising to **20 RPM / 1,000 RPD** once $10 has been purchased *cumulatively* — a lifetime-purchase
threshold, not a maintained balance. So: 50 RPD is a rounding error and this rung is close to
useless unless someone spends $10 once. Spending it is the single highest-value $10 in the build.
A negative balance returns 402 even on free models. Extra accounts and extra keys do not help;
limits are governed per account.

### 13.6 Cerebras and E2B give one-time credits, not recurring free tiers

Cerebras free is **$5 one-time**. E2B Hobby is **$100 one-time**. Both are burn-down, not renew.
E2B's $100 is generous enough to be a non-issue for a hackathon (~4 sandbox-hours per demo week),
but neither belongs in a "this runs free forever" claim. If this project continued past the
hackathon, Modal's **$30/month recurring** is the correct sandbox host and the driver interface in
§12.4 makes that a one-file change.

### 13.7 Granola has no public API

The one integration that cannot be built the way the diagram implies. Granola does not expose a
public API for notes. Two honest paths, both implemented:

1. **Drive-watched export** — Granola notes exported to a Google Drive folder; `changes.watch`
   picks them up. This is the path the demo uses, and it is a real workflow, not a hack.
2. **Paste-in** — a dashboard textarea and a `/ascendant note` Slack command that accept meeting
   notes directly and run them through the same Normalizer.

Both produce identical `NormalizedEvent`s with `kind: 'meeting_note'`, so nothing downstream knows
or cares. Say this out loud in the demo rather than hiding it — "no public API, so we ingest the
export" is a feasibility answer, and it demonstrates the connector abstraction is real.

### 13.8 What the system genuinely cannot do

State these before someone asks, because claiming otherwise is how a good submission loses trust:

- **Multi-repo or monorepo-wide refactors.** `MAX_FILES_TOUCHED = 12`. Anything larger ESCALATEs by
  design. This is a bounded-work system, not an autonomous engineer.
- **Anything without a test signal.** If a repo has no tests, the QA agent can only lint and
  typecheck, and confidence is capped at 0.7 accordingly — so it will never auto-act.
- **UI and visual work.** No screenshot diffing, no visual regression. Frontend tickets route to
  ESCALATE unless they are pure logic.
- **Architecture decisions.** The Planner refuses plans that add a dependency or change a public
  API contract; those become an ESCALATE with a written proposal for a human.
- **It does not replace an engineering team.** It removes triage toil and closes small,
  well-specified, test-covered tickets. That is a smaller claim than the original framing and a far
  more defensible one.

---

## 14. Edge cases

Grouped by where they bite. Each has a defined behaviour, not a hope.

### 14.1 Ingestion

| Case | Behaviour |
|---|---|
| Webhook delivered twice | `UNIQUE (source, sourceRef, contentHash)` → return existing id, no re-trigger |
| Webhook arrives while a run for the same thread is active | new event appended to the thread, run notified via `waitForEvent`; if the run is past planning it finishes and the new info opens a follow-up |
| Slack thread with 40 replies | collapsed to one event by `threadKey`; body truncated to 20k chars, oldest middle dropped, first and last preserved |
| Payload over 256 KiB | body stored in `artifacts`, event carries the id — the cap is never hit by design |
| Attachment is a 40 MB video | not downloaded; recorded as a citation-able URL only |
| Non-English issue | triaged in the source language; the reject/defer comment is written in that same language |
| Issue edited after a decision | edit is a new event with a `supersedes` link; if the prior decision was REJECT/MERGE, it auto-reopens for re-triage |
| Author deletes the issue mid-run | run detects 404 on hydrate, marks `abandoned`, destroys sandbox, no PR |
| Clock skew / out-of-order webhooks | ordering is by `sourceRef` sequence where available, never by receipt time |

### 14.2 Triage

| Case | Behaviour |
|---|---|
| Two near-identical issues arrive within seconds | advisory Postgres lock on `threadKey` hash serializes them; the second sees the first and returns MERGE |
| The "duplicate" is actually a regression of a closed issue | `already_closed_ref` policy rule → ESCALATE, never silent MERGE |
| Model returns MERGE with no `mergeTargetId` | Zod rejects, one repair retry, then ESCALATE |
| Every citation is low-similarity | `evidence_strength` collapses, confidence drops under 0.55 → ESCALATE |
| Issue is a question, not a bug | REJECT with `reason: 'support_request'` and a pointer to discussions; this is a real category, not a failure |
| Issue contradicts a documented decision | citation is the doc chunk; outcome is REJECT at high confidence — the most impressive single behaviour in the system |
| Repeat filing of something already rejected | decision-memory retrieval (§5.3 item 4) cites the prior rejection, consistency guaranteed |

### 14.3 Coding, QA, delivery

| Case | Behaviour |
|---|---|
| Diff doesn't apply (base moved) | rebase in sandbox, retry once, then ESCALATE with the conflict |
| Tests already failing on `main` | baseline test run happens *before* the diff; pre-existing failures are excluded from the verdict and reported in the PR |
| Coder deletes tests to make them pass | Reviewer has a hard rule: any diff reducing test count or assertions is an automatic reject; also a deterministic check, not just a prompt |
| Flaky test | failing test re-run 3×; passes 2 of 3 → marked flaky, noted in PR, not treated as failure |
| Infinite loop in generated code | sandbox 10-minute wall clock, then destroy |
| Diff touches `.github/`, CI config, secrets files, or lockfiles | blocked list → ESCALATE regardless of confidence |
| Two runs targeting the same file | branch-per-ticket means no conflict until merge; the second PR gets a "may conflict with #N" note |
| Linear is down | state transitions queue in `outbox` table, retried by the maintenance cron; the PR still ships |
| GitHub returns 403 secondary rate limit | exponential backoff honouring `Retry-After`, run sleeps via `step.sleep` (not a busy wait, so no concurrency slot burned) |
| Human closes the PR unmerged | `outcomes` row, feeds §11.3 |

### 14.4 Platform

| Case | Behaviour |
|---|---|
| All LLM rungs exhausted | ESCALATE `no_capacity`; dashboard banner shows quota state |
| Neon suspended | app serves read-only from the last dump; §13.1 offline path |
| Inngest concurrency saturated | runs queue; dashboard shows queue depth honestly rather than pretending |
| E2B credit exhausted | automatic switch to the Actions driver |
| Vercel function times out at 60s | cannot happen for agent work — handlers only verify and enqueue |
| Secret rotated / token revoked | connector health check on the maintenance cron surfaces it on the dashboard before a run discovers it |

---

## 15. Security

This system reads untrusted text from the internet and then writes code. That makes it a genuinely
interesting security surface, and treating it seriously is itself a differentiator — most agent
demos have no answer here at all.

### 15.1 Threat model

Four attackers worth defending against:

1. **Anonymous issue filer** — wants the agent to write a backdoor, exfiltrate a secret, or open a
   PR that a maintainer merges on trust.
2. **Injected content in an ingested document** — an email or meeting note containing text crafted to
   look like instructions to the model.
3. **The agent's own generated code** — untrusted by construction, regardless of intent.
4. **A compromised free-tier provider** — an LLM response that is itself hostile.

Note that 2 and 4 are not hypothetical. **While researching this plan, the web search tool returned
hijacked results: unrelated links plus text formatted to look like instructions to the agent, and a
trailing "REMINDER: You MUST …" line.** It happened twice, from a tool the agent had every reason to
trust. That is the exact attack this section defends against, and it is worth one sentence in the
demo — a real incident beats a hypothetical one.

### 15.2 Webhook authenticity

No handler processes a body before verifying it:

| Source | Verification |
|---|---|
| GitHub | HMAC-SHA256 of raw body vs `X-Hub-Signature-256`, timing-safe compare |
| Slack | `v0=` HMAC over `v0:timestamp:body`, reject if timestamp skew > 5 min (replay defence) |
| Linear | HMAC-SHA256 vs `Linear-Signature`, plus source-IP check against Linear's published ranges |
| Google Pub/Sub | OIDC JWT verification against Google's JWKS, audience pinned |
| Inngest | its own signing key, verified by the SDK |

Two details that matter in Next.js specifically: signature verification needs the **raw** body, so
the route reads `await req.text()` and parses after verifying — never `req.json()` first. And the
comparison must be `crypto.timingSafeEqual`, not `===`.

### 15.3 Prompt injection

Layered, because no single layer is sufficient.

**Layer 1 — classify.** Every ingested body runs through Groq's
**`meta-llama/llama-prompt-guard-2-86m`** (free: 30 RPM / 14,400 RPD / 500K TPD — comfortably enough
for every event). A positive detection does not block the event; it sets `injectionSuspected`, which
caps confidence at 0.5 and therefore forces ESCALATE. A human sees it, the agent never acts on it.

**Layer 2 — structural separation.** Untrusted text never enters the system prompt. It is passed as
a user-role message inside explicit delimiters with a standing instruction that content inside them
is *data to be analysed*, never instructions to follow:

```
<untrusted source="github:issue:1041" trust="anonymous">
...body...
</untrusted>
```

**Layer 3 — capability, not persuasion.** This is the layer that actually holds. The agent physically
cannot do the dangerous thing regardless of what it is convinced to attempt:

- the sandbox holds **no secrets** and cannot reach Neon, Inngest, or the GitHub API (§12.4)
- git push happens outside the sandbox, from the workflow, after the diff is read out
- writes to `.github/`, CI config, lockfiles, `.env*`, and any path matching a secrets pattern are
  **blocked deterministically**, not by prompt
- no auto-merge, ever — a human approves every merge
- `trust: 'anonymous'` events get a lower autonomy ceiling: they can be triaged and can produce a
  draft PR, but never an autonomous close

**Layer 4 — output validation.** The Coder's diff is scanned before it leaves the pipeline: added
network calls to non-allowlisted hosts, new `eval`/`exec`/`child_process` usage, new dependencies,
base64 blobs, and anything resembling a credential all force ESCALATE. The Reviewer agent sees the
scan results as input, so its verdict is informed by them rather than duplicating them.

The honest framing for the write-up: **layers 1 and 2 reduce the rate; layer 3 bounds the damage.**
A defence that depends on the model not being fooled is not a defence.

### 15.4 Secrets and tenancy

- All credentials in Vercel environment variables, none in the repo, `.env.example` documents names
  only. The GitHub App private key is stored base64-encoded and decoded at runtime.
- GitHub App installation tokens are minted per-run and expire in 1 hour — no long-lived PAT.
- Google OAuth stays in **testing** consent mode with your own account, so scopes are `readonly`
  and no verification is needed.
- Least privilege throughout: Contents R/W is the only write scope on GitHub beyond issues and PRs;
  Drive/Gmail/Calendar are read-only; Slack has `chat:write` and nothing else.
- Every autonomous action writes an `agent_events` row with actor `ascendant`, the decision id, and
  the model used. Fully attributable after the fact.
- Multi-tenant readiness: every table carries `org_id` and every query filters on it. Not exercised
  in the demo, but it means "how would this work for two companies?" has a one-sentence answer.
- Secret scanning in CI (`gitleaks`) on the repo itself, so the project doesn't fail the standard it
  sets for others.

---

## 16. The demo

Four minutes. The whole thing runs against seeded, real data, live, with a recorded fallback.

### 16.1 The seed

`scripts/seed-demo.ts` populates a public demo repo (a small real TypeScript API with tests) plus
the Postgres corpus: ~40 historical issues, 12 merged PRs, 3 design docs, 2 meeting notes, and one
architecture decision doc that says *"we are not adding a GraphQL layer, decided 2026-06-12."*

That last document is the setup for the best moment in the demo.

### 16.2 The four beats

**Beat 1 — open with a rejection (60s).** File a new issue: *"Please add a GraphQL endpoint for
sessions."* Watch the Inbox. Ascendant returns **REJECT, confidence 0.89**, citing the decision doc
with the quoted line and date, and posts a comment explaining it — offering `/ascendant reopen`.

Nothing else in the market does this. Every competitor would have started writing a GraphQL layer.
Say exactly that, right here.

**Beat 2 — the other three non-ACCEPT paths (60s).** Three pre-staged events fire in sequence:
a reworded duplicate → **MERGE** with both stack traces quoted side by side; a one-line issue with
no repro → **DEFER** with three specific questions posted as a comment; an ambiguous
performance complaint → **ESCALATE**, appearing as a Slack message with Approve / Escalate / Reject
buttons. Click one in front of the judges.

**Beat 3 — then it builds (90s).** A genuine bug issue → **ACCEPT** → Linear ticket → the Run
Detail timeline. This is where the "agents argue" claim has to be *legible*, so it renders as a
structured thread: Planner's plan, Reviewer's two objections with severities, Planner's revision,
Coder's diff, Reviewer's line comment, Coder's fix, QA's test output going red then green. Ends with
a real draft PR on GitHub containing the decision trailer.

Pre-warm the E2B template before you present (§12.2 step 8) so this is ~5s of startup, not 90.

**Beat 4 — the number (30s).** The Metrics view: the 60-event eval confusion matrix, triage
precision, cycle time, and the token/quota panel showing the run cost $0.00. Then the Policy view —
drag the autonomy threshold from 0.80 to 0.95 and re-run Beat 1's issue: same decision, now routed
to a human instead of acted on. That single interaction proves the confidence scoring is real
machinery rather than a displayed number.

### 16.3 Demo-day insurance

Non-negotiable, all four:

1. **A recorded 4-minute screen capture** of the full flow. Live-demo, but have this queued. Ship
   the link on the Working Prototype slide either way.
2. **`pg_dump` of the seeded DB in the repo** + local Postgres/pgvector via Docker, so a Neon
   suspension (§13.1) costs you one env var.
3. **A `DEMO_MODE=replay` flag** that serves stored `agent_events` from the seeded run at original
   timing. Not fake — it is genuine recorded output from a real execution, replayed. Say so if you
   use it; conference wifi is a legitimate reason and honesty here costs nothing.
4. **Run `pnpm eval` the night before, not the morning of.** It consumes ~1,500 Groq requests
   against a 1,000 RPD ceiling (§13.4). Burning the day's quota at 9am is the single most likely way
   to lose this demo.

### 16.4 Mapping to the seven required slides

| Slide | Content |
|---|---|
| 1. Team | — |
| 2. Problem statement | Coding agents assume the ticket is valid. The expensive failure is upstream: duplicates, already-fixed, contradicts-a-decision, user-error, shouldn't-be-a-ticket. Quantify with the seeded corpus: N of 40 historical issues should never have reached an engineer. |
| 3. Solution | The Triage Gate and its five outcomes. *"Decides what to build. Then builds it."* Lead with REJECT. |
| 4. Architecture | The §2 diagram, with the five-outcome branch drawn prominently. |
| 5. Technology used | The §3 table plus the §12.1 topology. State $0.00 running cost and name the binding constraint (Groq RPD) — knowing your own limit reads as engineering maturity. |
| 6. Working prototype | Recorded demo link + the live URL. |
| 7. Utility / scalability | §11.2's confusion matrix, §13.8's honest limits, and the scaling path: Inngest Pro or the ~400-line Temporal port, Modal for sandboxes, multi-tenant via `org_id`. |

### 16.5 Answers to the three questions you will be asked

**"How is this different from Devin / Copilot Workspace?"** They start at "implement this." Ascendant
decides whether "this" should be implemented, and four of its five outcomes are refusals. Different
product, upstream of theirs.

**"What if the triage is wrong?"** Three layers: confidence bands mean low-confidence never acts
autonomously; every autonomous action has a one-command undo; every overturn is recorded and becomes
a few-shot example plus an eval-set row. Then show the confusion matrix — and point at the cell that
matters, false REJECTs, rather than the headline number.

**"Does it actually work or is this a demo?"** It ran live. The PR is on GitHub with a decision
trailer you can click through to the exact event, retrieval set, and debate transcript that produced
it. The eval set is 60 hand-labelled real issues. And here is what it explicitly cannot do (§13.8).

---

## 17. What "actually works" means here

The distinction between this and demo-ware is four properties, each already load-bearing above:

1. **Every agent is a pure function** (§3) — unit-testable with no network, and the whole pipeline is
   replayable from stored inputs.
2. **Every blob is in Postgres, every event carries an id** (§4.3) — so a large real ticket behaves
   the same as a small seeded one.
3. **Every failure mode has a named outcome** (§14) — ESCALATE with a transcript is a success state.
   The system has no path that silently produces garbage.
4. **Every claim has a number behind it** (§11.2, §12.3) — triage precision from a real eval set,
   cost from real quota accounting.

Build order, if time runs short — but note that nothing gets cut, only sequenced:

```
1. db schema + Normalizer + GitHub connector          ← ingestion works
2. Triage Gate + retrieval + decision object          ← the thesis works
3. Dashboard Inbox + Run Detail                       ← it's visible
4. Inngest workflows + LLM router                     ← it's durable
5. Planner/Coder/Reviewer/QA + E2B sandbox            ← it builds
6. Delivery: PR + Linear + Slack                      ← it ships
7. Remaining connectors (Linear/Gmail/GCal/Drive/Granola)
8. Learning loop + eval set + metrics
9. Security layers 1-4 hardening
10. Seed fixtures + recorded demo + offline fallbacks
```

Steps 1-3 alone are a defensible submission. Steps 1-6 are a strong one. All ten is the plan.

