CREATE TYPE "public"."webhook_replay_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "public"."accounting_entity_kind" ADD VALUE 'credit_note';--> statement-breakpoint
ALTER TYPE "public"."accounting_entity_kind" ADD VALUE 'credit_note_application';--> statement-breakpoint
ALTER TYPE "public"."accounting_entity_kind" ADD VALUE 'credit_note_void';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_sequence" integer NOT NULL,
	"event_name" text NOT NULL,
	"attempt" integer NOT NULL,
	"replay_id" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"response_status" integer,
	"response_excerpt" text,
	"error" text,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_replay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid,
	"from_sequence" integer NOT NULL,
	"through_sequence" integer NOT NULL,
	"position" integer NOT NULL,
	"status" "webhook_replay_status" DEFAULT 'pending' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"requested_by_user_id" uuid,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_replay_id_webhook_replay_id_fk" FOREIGN KEY ("replay_id") REFERENCES "public"."webhook_replay"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_replay" ADD CONSTRAINT "webhook_replay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_replay" ADD CONSTRAINT "webhook_replay_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_replay" ADD CONSTRAINT "webhook_replay_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_delivery_endpoint_idx" ON "webhook_delivery" USING btree ("organization_id","endpoint_id","requested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_delivery_event_idx" ON "webhook_delivery" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_replay_pending_idx" ON "webhook_replay" USING btree ("organization_id","endpoint_id","status");