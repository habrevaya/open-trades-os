CREATE TYPE "public"."ai_agent_kind" AS ENUM('intake', 'chat', 'estimate', 'collections', 'dispatch');--> statement-breakpoint
CREATE TYPE "public"."ai_chat_status" AS ENUM('open', 'handed_off', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ai_proposal_status" AS ENUM('proposed', 'applied', 'dismissed', 'failed', 'superseded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_agent_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent" "ai_agent_kind" NOT NULL,
	"kind" text NOT NULL,
	"proposal_id" uuid,
	"detail" text NOT NULL,
	"actor_user_id" uuid,
	"automatic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_agent_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent" "ai_agent_kind" NOT NULL,
	"action" text NOT NULL,
	"status" "ai_proposal_status" DEFAULT 'proposed' NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"summary" text NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_id" uuid,
	"run_as_user_id" uuid,
	"started_by_user_id" uuid,
	"applied_automatically" boolean DEFAULT false NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"outcome" jsonb,
	"note" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_agent_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent" "ai_agent_kind" NOT NULL,
	"run_as_user_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_chat_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" "ai_chat_status" DEFAULT 'open' NOT NULL,
	"token_hash" text,
	"visitor_id" text,
	"agent_turns" integer DEFAULT 0 NOT NULL,
	"booking_request_id" uuid,
	"handed_off_at" timestamp with time zone,
	"handoff_reason" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_activity" ADD CONSTRAINT "ai_agent_activity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_activity" ADD CONSTRAINT "ai_agent_activity_proposal_id_ai_agent_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."ai_agent_proposal"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_activity" ADD CONSTRAINT "ai_agent_activity_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_proposal" ADD CONSTRAINT "ai_agent_proposal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_proposal" ADD CONSTRAINT "ai_agent_proposal_usage_id_ai_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."ai_usage"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_proposal" ADD CONSTRAINT "ai_agent_proposal_run_as_user_id_user_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_proposal" ADD CONSTRAINT "ai_agent_proposal_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_proposal" ADD CONSTRAINT "ai_agent_proposal_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_setting" ADD CONSTRAINT "ai_agent_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_setting" ADD CONSTRAINT "ai_agent_setting_run_as_user_id_user_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_agent_setting" ADD CONSTRAINT "ai_agent_setting_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_session" ADD CONSTRAINT "ai_chat_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_session" ADD CONSTRAINT "ai_chat_session_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_session" ADD CONSTRAINT "ai_chat_session_booking_request_id_booking_request_id_fk" FOREIGN KEY ("booking_request_id") REFERENCES "public"."booking_request"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_activity_list_idx" ON "ai_agent_activity" USING btree ("organization_id","agent","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_proposal_open_idx" ON "ai_agent_proposal" USING btree ("organization_id","agent","source_kind","source_id") WHERE "ai_agent_proposal"."status" = 'proposed';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_proposal_idempotency_idx" ON "ai_agent_proposal" USING btree ("organization_id","idempotency_key") WHERE "ai_agent_proposal"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_proposal_list_idx" ON "ai_agent_proposal" USING btree ("organization_id","agent","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_proposal_source_idx" ON "ai_agent_proposal" USING btree ("organization_id","source_kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_setting_agent_idx" ON "ai_agent_setting" USING btree ("organization_id","agent");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_chat_session_token_idx" ON "ai_chat_session" USING btree ("token_hash") WHERE "ai_chat_session"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_chat_session_conversation_idx" ON "ai_chat_session" USING btree ("conversation_id");