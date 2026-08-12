CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "kind" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_until" timestamp with time zone,
  "locked_by" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "outbox_status_check" CHECK ("status" IN ('pending', 'processing', 'done'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_uq" ON "outbox" USING btree ("org_id", "dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_ready_idx" ON "outbox" USING btree ("status", "available_at", "created_at");--> statement-breakpoint
CREATE INDEX "outbox_lease_idx" ON "outbox" USING btree ("locked_until") WHERE "status" = 'processing';--> statement-breakpoint
CREATE FUNCTION ascendant_enqueue_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO outbox (org_id, dedupe_key, kind, aggregate_id, payload)
  VALUES (
    NEW.org_id,
    'inngest:event:' || NEW.id::text,
    'inngest_event',
    NEW.id::text,
    jsonb_build_object(
      'id', 'ascendant:event:' || NEW.id::text,
      'name', 'event/received',
      'data', jsonb_build_object('orgId', NEW.org_id, 'eventId', NEW.id, 'source', NEW.source, 'sourceRef', NEW.source_ref)
    )
  ) ON CONFLICT (org_id, dedupe_key) DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER events_enqueue_outbox AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION ascendant_enqueue_event();--> statement-breakpoint
CREATE FUNCTION ascendant_enqueue_human_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision_row decisions%ROWTYPE;
  actor_name text;
BEGIN
  IF NEW.kind NOT IN ('human_confirmed', 'human_overridden') THEN RETURN NEW; END IF;
  SELECT * INTO decision_row FROM decisions WHERE id = NEW.decision_id;
  actor_name := COALESCE(NEW.meta->>'actor', 'authorized-reviewer');
  INSERT INTO outbox (org_id, dedupe_key, kind, aggregate_id, payload)
  VALUES (
    NEW.org_id,
    'inngest:human:' || decision_row.event_id::text || ':' || decision_row.outcome::text,
    'inngest_event',
    decision_row.event_id::text,
    jsonb_build_object(
      'id', 'ascendant:human:' || decision_row.event_id::text || ':' || decision_row.outcome::text,
      'name', 'human/resolved',
      'data', jsonb_build_object('orgId', NEW.org_id, 'eventId', decision_row.event_id,
        'decisionId', decision_row.id, 'outcome', decision_row.outcome, 'actor', actor_name,
        'reason', NEW.note)
    )
  ) ON CONFLICT (org_id, dedupe_key) DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER outcomes_enqueue_human_resolution AFTER INSERT ON outcomes
FOR EACH ROW EXECUTE FUNCTION ascendant_enqueue_human_resolution();
