ALTER TYPE "public"."capability" ADD VALUE 'transcription';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "answering_phone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "phone_menu" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"greeting" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_input_to" jsonb NOT NULL,
	"after_hours_to" jsonb,
	"timeout_seconds" integer DEFAULT 6 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ring_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"strategy" text NOT NULL,
	"ring_seconds" integer DEFAULT 20 NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_answer_to" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_text" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_status" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_source" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_error" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "menu_choices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "reply_token" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "menu_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "adopted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "previous_voice_url" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "previous_status_url" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "answering_phone" ADD CONSTRAINT "answering_phone_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "answering_phone" ADD CONSTRAINT "answering_phone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_menu" ADD CONSTRAINT "phone_menu_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ring_group" ADD CONSTRAINT "ring_group_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "answering_phone_person_idx" ON "answering_phone" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_menu_org_idx" ON "phone_menu" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ring_group_org_idx" ON "ring_group" USING btree ("organization_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_menu_id_phone_menu_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."phone_menu"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcript_search_idx" ON "call" USING gin (to_tsvector('english', coalesce("transcript_text", '')));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcript_pending_idx" ON "call" USING btree ("organization_id") WHERE "call"."transcript_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_reply_token_idx" ON "conversation" USING btree ("reply_token") WHERE "conversation"."reply_token" is not null;