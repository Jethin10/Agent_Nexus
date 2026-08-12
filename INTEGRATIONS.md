# Real integration setup

Ascendant now has executable integration paths for GitHub, Linear, Slack, Inngest,
and the sandbox. Credentials are intentionally not committed. Run:

```bash
cp .env.example .env.local   # or configure the same names in Vercel
pnpm integrations:check     # read-only; creates no external records
```

Use `pnpm integrations:check --strict` before recording or deploying.

## GitHub

The public fixture is [`Jethin10/ascendant-demo-api`](https://github.com/Jethin10/ascendant-demo-api),
whose default branch contains the small session fixture used by `pnpm demo:build`
(`src/session.ts` and `src/session.test.ts`). Its first guarded delivery is visible as
[PR #1](https://github.com/Jethin10/ascendant-demo-api/pull/1). Configure a GitHub App with:

- Repository metadata: read
- Issues: read/write
- Pull requests: read/write
- Contents: read/write

Subscribe its webhook to issues, issue comments, and pull requests, with the URL:

```text
https://<deployment>/api/webhooks/github
```

Set `GITHUB_WEBHOOK_SECRET`, `GITHUB_OWNER`, `GITHUB_REPO`, and
`GITHUB_DEFAULT_BRANCH`. In production, set `GITHUB_APP_ID` and the app's PEM private
key as base64 in `GITHUB_APP_PRIVATE_KEY_BASE64`; Ascendant signs a short-lived app JWT,
finds the configured repository installation, and mints a repository-scoped one-hour
installation token for each workflow invocation. The token is never persisted or sent
to an agent or sandbox. For local verification only, `GITHUB_TOKEN` may be a short-lived
fine-grained token scoped to the configured repository. App credentials take precedence
when both authentication methods are present.

The normal workflow posts the decision back to a matching configured GitHub issue.
Autonomous REJECT/MERGE decisions may close it as `not_planned`; every outcome gets
an `ascendant:<outcome>` label. `pnpm demo:build --publish` has an additional guard:
it refuses to publish unless the configured repository files match the reviewed demo
baseline exactly.

## Linear

Create a team whose workflow includes these exact state names:

```text
Triage · Todo · In Progress · In Review · Done
```

Set `LINEAR_API_KEY` and `LINEAR_TEAM_ID`. Ascendant creates the Linear issue at
ACCEPT, stores its id and identifier, moves it to In Progress while coding, In Review
after QA, and Done after GitHub delivery.

## Slack

Create a Slack app with bot scopes:

```text
chat:write
```

Invite the bot to the configured channel, then set `SLACK_BOT_TOKEN` and the channel
ID (a `C...` id, not a `#name`) as `SLACK_CHANNEL_ID`.

Enable interactivity with:

```text
https://<deployment>/api/webhooks/slack
```

Set `SLACK_SIGNING_SECRET`. Ascendant verifies Slack's HMAC over the raw body and
rejects timestamps older than five minutes. Review buttons persist a human outcome
or immutable overturn before emitting `human/resolved` to resume a parked Inngest
run.

## Inngest and database

Configure a Neon Postgres database with pgvector and apply the migration. Set
`DATABASE_URL`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY`. Serve functions at:

```text
https://<deployment>/api/inngest
```

The local path uses PGlite and does not need Inngest. If a local human review is
recorded while Inngest is disconnected, the UI explicitly says the audit record is
persisted and workflow continuation is pending.

## Model and embeddings

Real model inference is intentionally opt-in:

```text
ASCENDANT_LIVE=1
GROQ_API_KEY=...
```

Provider keys without `ASCENDANT_LIVE=1` continue to use schema-validated fixtures,
labelled `fixture:*`. Set `GEMINI_API_KEY` before `pnpm seed:demo` for semantic
embeddings; without it, deterministic hashed vectors exercise the real pgvector path
but are explicitly labelled non-semantic.

## Sandbox

Use `E2B_API_KEY` and an E2B template for isolated generated-code execution. The
local harness is deliberately explicit:

```bash
pnpm demo:build
```

It runs in a temporary local directory and is **not an isolation boundary**. It is
only the offline demo path. Never enable `ASCENDANT_ALLOW_LOCAL_SANDBOX=1` in a
public deployment.

## Honest end-to-end rehearsal

```bash
pnpm seed:demo
pnpm demo
pnpm demo:build
pnpm integrations:check
pnpm dev
```

Then open `/demo`, the ACCEPT audit timeline, `/metrics`, and `/policy`. Add
`--publish` only after the dedicated GitHub demo repository is configured and the
read-only integration check passes.
