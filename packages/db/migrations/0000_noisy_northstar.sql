-- Hand-added (§9.1): drizzle-kit does not emit this, and the vector(768)/vector(384)
-- columns on `embeddings` plus their HNSW indexes fail without it. Must stay first.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('plan', 'diff', 'review', 'test_log', 'transcript', 'pr_body', 'file_snapshot');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('issue', 'pr', 'comment', 'message', 'email', 'meeting_note', 'doc', 'command');--> statement-breakpoint
CREATE TYPE "public"."triage_outcome" AS ENUM('ACCEPT', 'REJECT', 'MERGE', 'DEFER', 'ESCALATE');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled', 'waiting');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('github', 'linear', 'slack', 'gmail', 'gcal', 'gdrive', 'granola');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('planning', 'coding', 'reviewing', 'qa', 'delivering', 'done', 'blocked', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."trust_level" AS ENUM('internal', 'known_external', 'anonymous');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"source" "source" NOT NULL,
	"source_ref" text NOT NULL,
	"kind" "event_kind" NOT NULL,
	"unit_key" text NOT NULL,
	"thread_key" text,
	"actor_id" text NOT NULL,
	"actor_handle" text NOT NULL,
	"actor_is_bot" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"extracted" jsonb NOT NULL,
	"trust" "trust_level" NOT NULL,
	"injection_suspected" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"outcome" "triage_outcome" NOT NULL,
	"confidence" double precision NOT NULL,
	"reasoning" text NOT NULL,
	"citations" jsonb NOT NULL,
	"merge_target_id" text,
	"missing_info" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_hits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_self_report" double precision,
	"evidence_strength" double precision,
	"policy_agreement" double precision,
	"autonomous" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"model_used" text NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"status" "ticket_status" DEFAULT 'planning' NOT NULL,
	"linear_id" text,
	"linear_identifier" text,
	"branch" text,
	"pr_number" integer,
	"pr_url" text,
	"pr_is_draft" boolean DEFAULT true NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" uuid,
	"fn" text NOT NULL,
	"inngest_run_id" text,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"meta" jsonb,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" uuid,
	"run_id" uuid,
	"agent" text NOT NULL,
	"phase" text NOT NULL,
	"round" integer,
	"summary" text NOT NULL,
	"detail" jsonb,
	"model" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" uuid,
	"run_id" uuid,
	"kind" "artifact_kind" NOT NULL,
	"round" integer,
	"agent" text,
	"content" text NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"content" text NOT NULL,
	"chunk" integer DEFAULT 0 NOT NULL,
	"model" text,
	"vec768" vector(768),
	"vec384" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"ticket_id" uuid,
	"kind" text NOT NULL,
	"correct" boolean,
	"review_cycles" integer DEFAULT 0 NOT NULL,
	"tokens_total" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"note" text,
	"meta" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overturns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"from_outcome" "triage_outcome" NOT NULL,
	"to_outcome" "triage_outcome" NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"note" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overturns" ADD CONSTRAINT "overturns_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_ref_uq" ON "events" USING btree ("org_id","source","source_ref");--> statement-breakpoint
CREATE INDEX "events_unit_key_idx" ON "events" USING btree ("org_id","unit_key");--> statement-breakpoint
CREATE INDEX "events_content_hash_idx" ON "events" USING btree ("org_id","content_hash");--> statement-breakpoint
CREATE INDEX "events_created_idx" ON "events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "decisions_event_idx" ON "decisions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "decisions_outcome_idx" ON "decisions" USING btree ("org_id","outcome","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_event_uq" ON "tickets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("org_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "runs_ticket_idx" ON "runs" USING btree ("ticket_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_inngest_idx" ON "runs" USING btree ("inngest_run_id");--> statement-breakpoint
CREATE INDEX "agent_events_ticket_idx" ON "agent_events" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "agent_events_run_idx" ON "agent_events" USING btree ("run_id","at");--> statement-breakpoint
CREATE INDEX "artifacts_ticket_kind_idx" ON "artifacts" USING btree ("ticket_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_entity_uq" ON "embeddings" USING btree ("org_id","entity_kind","entity_id","chunk");--> statement-breakpoint
CREATE INDEX "embeddings_vec768_hnsw" ON "embeddings" USING hnsw ("vec768" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "embeddings_vec384_hnsw" ON "embeddings" USING hnsw ("vec384" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "embeddings_fts_idx" ON "embeddings" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "outcomes_decision_idx" ON "outcomes" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "outcomes_kind_idx" ON "outcomes" USING btree ("org_id","kind","observed_at");--> statement-breakpoint
CREATE INDEX "overturns_decision_idx" ON "overturns" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "overturns_matrix_idx" ON "overturns" USING btree ("org_id","from_outcome","to_outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "config_org_key_uq" ON "config" USING btree ("org_id","key");