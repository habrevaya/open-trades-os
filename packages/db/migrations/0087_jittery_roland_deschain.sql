CREATE TYPE "public"."voice_agent_status" AS ENUM('waiting', 'talking', 'transferred', 'ended', 'dropped');--> statement-breakpoint
ALTER TYPE "public"."ai_agent_kind" ADD VALUE 'voice';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ring_group_id" uuid NOT NULL,
	"max_wait_seconds" integer DEFAULT 300 NOT NULL,
	"announce_position" boolean DEFAULT true NOT NULL,
	"hold_music_url" text,
	"overflow_to" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "softphone_presence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_agent_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "voice_agent_status" DEFAULT 'waiting' NOT NULL,
	"turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_turns" integer DEFAULT 0 NOT NULL,
	"redactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL,
	"booking_request_id" uuid,
	"message_taken" boolean DEFAULT false NOT NULL,
	"transfer_reason" text,
	"closing_words" text,
	"ending" text,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "placed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queue_id" uuid;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queue_rung_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queue_rings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queue_result" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_queue" ADD CONSTRAINT "call_queue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_queue" ADD CONSTRAINT "call_queue_ring_group_id_ring_group_id_fk" FOREIGN KEY ("ring_group_id") REFERENCES "public"."ring_group"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "softphone_presence" ADD CONSTRAINT "softphone_presence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "softphone_presence" ADD CONSTRAINT "softphone_presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_agent_session" ADD CONSTRAINT "voice_agent_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_agent_session" ADD CONSTRAINT "voice_agent_session_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_agent_session" ADD CONSTRAINT "voice_agent_session_booking_request_id_booking_request_id_fk" FOREIGN KEY ("booking_request_id") REFERENCES "public"."booking_request"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_queue_org_idx" ON "call_queue" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "softphone_presence_person_idx" ON "softphone_presence" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_agent_session_call_idx" ON "voice_agent_session" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_agent_session_token_idx" ON "voice_agent_session" USING btree ("token_hash");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_placed_by_user_id_user_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_queue_id_call_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."call_queue"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
