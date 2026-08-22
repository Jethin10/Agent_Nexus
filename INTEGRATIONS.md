# Real integration setup

Ascendant has executable integration paths for GitHub, Gmail context, Slack context
and review actions, Linear, Inngest, and the sandbox. Credentials are intentionally
not committed. Run:

```bash
cp .env.example .env.local   # or configure the same names in Vercel
pnpm integrations:check     # read-only; creates no external records
```

Use `pnpm integrations:check --strict` before recording or deploying.

## Vercel deployment

The repository root now contains `vercel.json`, so import the repository with the
project root left at the repository root. The checked-in configuration pins Node 22,
installs the frozen pnpm workspace, builds only the Next.js application, and publishes
`apps/web/.next`. Add the server credentials described below to the Vercel project
before the first deployment. User-installed tokens, channels, and repositories are
not deployment variables; they are selected from `/integrations` and encrypted at
rest. The build fails closed when required runtime or OAuth-app settings are absent.

## One-click account connections

Set `OAUTH_STATE_SECRET` to at least 32 random characters and
`ASCENDANT_CONNECTIONS_KEY` to 32 random bytes encoded as base64 (or 64 hex
characters). OAuth callbacks require signed ten-minute state tied to an HttpOnly,
SameSite cookie. Stored refresh and bot tokens use AES-256-GCM with
organization/provider-bound authenticated data.

Open `/integrations` behind dashboard authentication to connect GitHub, Slack, and
Gmail. Only the exact provider callback GET paths bypass HTTP Basic because providers
cannot replay the operator's Authorization header. Starts, disconnects, repository
changes, and syncs remain authenticated and protected by same-origin mutation checks.

Before deploying, run the single read-only cutover gate:

```bash
pnpm deploy:check
```

After deployment, `GET /api/health` returns `200` only when Postgres is reachable and
every configured integration is production-ready. It returns names and readiness
states only—never credentials. GitHub, Slack, and Inngest webhook routes remain signed
and do not sit behind the dashboard's HTTP Basic gate.

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

Set `GITHUB_WEBHOOK_SECRET`. `GITHUB_OWNER`, `GITHUB_REPO`, and
`GITHUB_DEFAULT_BRANCH` are optional local fallbacks. In production, set `GITHUB_APP_ID` and the app's PEM private
key as base64 in `GITHUB_APP_PRIVATE_KEY_BASE64`; Ascendant signs a short-lived app JWT,
finds the configured repository installation, and mints a repository-scoped one-hour
installation token for each workflow invocation. The token is never persisted or sent
to an agent or sandbox. For local verification only, `GITHUB_TOKEN` may be a short-lived
fine-grained token scoped to the configured repository, but it is disabled unless
`ASCENDANT_ALLOW_GITHUB_TOKEN=1` is also set. Never set that flag in production. App
credentials take precedence when both authentication methods are present.

For hosted installation, also set `GITHUB_APP_SLUG` and configure the GitHub App setup
URL as `https://<deployment>/api/connect/github/callback`. Ascendant stores the
installation id and selected repository, then mints short-lived installation tokens
on demand. `GITHUB_OWNER` and `GITHUB_REPO` are optional local fallbacks.

Encode the GitHub App PEM without copying it into the repository:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\to\app.pem'))
```

```bash
base64 < /path/to/app.pem | tr -d '\n'
```

For a local fine-grained PAT, grant only repository access to the demo repository with
Contents read/write, Issues read/write, Pull requests read/write, and Metadata read.
Set `ASCENDANT_ALLOW_GITHUB_TOKEN=1` locally. The flag is intentionally required so a
stray shell token cannot silently become production authorization.

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
chat:write · channels:history
```

Invite the bot to the configured channel, then set `SLACK_BOT_TOKEN` and the channel
ID (a `C...` id, not a `#name`) as `SLACK_CHANNEL_ID`.
Set `SLACK_INGEST_CHANNEL_ID` to the bounded conversation channel used for history
sync. For multiple signed Events API channels, set comma-separated
`SLACK_INGEST_CHANNEL_IDS`. Subscribe the app to `message.channels` and use the same
signed endpoint below. Bot messages are ignored so Ascendant never ingests its own
delivery notifications.

Enable interactivity with:

```text
https://<deployment>/api/webhooks/slack
```

Set `SLACK_SIGNING_SECRET`. The member who installs the app becomes the initial
reviewer; `SLACK_REVIEWER_IDS` remains an optional comma-separated local/additional
allowlist. Ascendant verifies Slack's HMAC over the raw body, rejects timestamps older
than five minutes, and rejects reviewers outside the stored workspace allowlist.
Review buttons persist a human outcome
or immutable overturn before emitting `human/resolved` to resume a parked Inngest
run.

For one-click installation, also grant `groups:history` and `incoming-webhook`, set
`SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, and register
`https://<deployment>/api/connect/slack/callback`. The bot token, chosen channel,
workspace id, and installer reviewer are encrypted in the database. The selected
channel governs live ingestion as well as history sync; static `SLACK_BOT_TOKEN` and
`SLACK_CHANNEL_ID` are optional local fallbacks.

## Gmail

Create a Google Cloud OAuth client and authorize only:

```text
https://www.googleapis.com/auth/gmail.readonly
```

Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`; the Connect Gmail flow obtains and
encrypts the refresh token. `GMAIL_REFRESH_TOKEN` is only a local fallback. Apply the
label `ascendant` only to the threads you want the
judge demo to use, then keep the default safety query:

```text
GMAIL_QUERY=label:ascendant newer_than:30d
```

The dashboard's Integrations page has a “Sync Gmail + Slack” control. It fetches a
bounded history, stores immutable provider ids, deduplicates repeats, and dispatches
new records through the same triage pipeline when Inngest is configured. It never
sends, modifies, labels, or deletes mail.

For one-click Gmail authorization, register
`https://<deployment>/api/connect/google/callback`. Ascendant requests offline access
and explicit consent, then encrypts the refresh token. `GMAIL_REFRESH_TOKEN` remains
an optional local fallback.

## Inngest and database

Configure a Neon Postgres database with pgvector and apply the migration. Set
`DATABASE_URL`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY`. Deployed builds fail
closed when durable database or signed workflow configuration is absent. Serve functions at:

```text
https://<deployment>/api/inngest
```

For a local real-time webhook rehearsal, run the two processes in separate terminals:

```bash
pnpm dev
pnpm dev:inngest
```

`pnpm dev` sets `INNGEST_DEV=1`; the second command starts the official local Inngest
server and registers `/api/inngest`. PGlite holds the durable local data. If a human
review is recorded while Inngest is disconnected, the UI explicitly says the audit
record is persisted and workflow continuation is pending.

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

Use `E2B_API_KEY` and optionally an E2B template for isolated generated-code execution.
The pinned `e2b` SDK ships with the runtime. Experimental Actions execution is disabled
unless `ASCENDANT_ALLOW_ACTIONS_SANDBOX=1`; it does not satisfy production readiness. The
local harness is deliberately explicit:

```bash
pnpm demo:build
```

It runs in a temporary local directory and is **not an isolation boundary**. It is
only the offline demo path. Never enable `ASCENDANT_ALLOW_LOCAL_SANDBOX=1` in a
public deployment.

## Production cutover

Set `ASCENDANT_DASHBOARD_PASSWORD` and a stable audit identity in
`ASCENDANT_OPERATOR_NAME`. Deployment builds reject incomplete production configuration
instead of silently exposing partial integrations.

```bash
pnpm db:push
pnpm corpus:sync             # backfill real issues + merged PRs and semantic embeddings
pnpm integrations:check --strict
pnpm build
```

After deployment, point GitHub, Slack, and Inngest at the signed endpoints listed above,
then open `/integrations`, sync the labelled Gmail/Slack context, and confirm every
required connection is ready. Open `/ledger` to rehearse the source history. Create a
real, bounded issue in the configured repository and verify this journey:

1. GitHub receives the webhook with a `2xx` response.
2. The event and immutable decision appear in the Inbox and audit timeline.
3. GitHub receives the decision comment and outcome label.
4. An ACCEPT creates the Linear item and Slack thread, then runs planning, QA, and delivery.
5. The resulting GitHub pull request is reviewable and is never auto-merged.

The `seed:demo`, `demo`, and `demo:build` commands remain local test fixtures and are not
part of the production showcase path.
