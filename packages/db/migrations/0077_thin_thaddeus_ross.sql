CREATE TYPE "public"."incident_kind" AS ENUM('injury', 'near_miss', 'property_damage', 'vehicle', 'environmental', 'other');--> statement-breakpoint
CREATE TYPE "public"."incident_person_role" AS ENUM('injured', 'involved', 'witness');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."connected_app_source" AS ENUM('operator', 'request', 'oauth');--> statement-breakpoint
ALTER TYPE "public"."connected_app_status" ADD VALUE 'refused';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"placed_by_user_id" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" uuid,
	"release_note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_purge_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"requested_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"purged" integer DEFAULT 0 NOT NULL,
	"held" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incident_person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"technician_id" uuid,
	"name" text NOT NULL,
	"role" "incident_person_role" NOT NULL,
	"injury" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incident_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "incident_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"location" text,
	"property_id" uuid,
	"job_id" uuid,
	"description" text NOT NULL,
	"immediate_action" text,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"reported_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"closing_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "safety_meeting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"notes" text,
	"held_at" timestamp with time zone NOT NULL,
	"location" text,
	"job_id" uuid,
	"led_by" text,
	"created_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "safety_meeting_attendee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"technician_id" uuid,
	"name" text NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_via" text,
	"signed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"registered_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"approved_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"issued_token_id" uuid,
	"family_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"access_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "source" "connected_app_source" DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "redirect_uri" text;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "request_state" text;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "requested_from" text;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "request_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "claim_hash" text;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "refused_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "refused_reason" text;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "previous_secret_ref" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "previous_secret_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "secret_rotated_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_hold" ADD CONSTRAINT "retention_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_hold" ADD CONSTRAINT "retention_hold_placed_by_user_id_user_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_hold" ADD CONSTRAINT "retention_hold_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_purge_run" ADD CONSTRAINT "retention_purge_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_purge_run" ADD CONSTRAINT "retention_purge_run_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_person" ADD CONSTRAINT "incident_person_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_person" ADD CONSTRAINT "incident_person_incident_id_incident_report_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident_report"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_person" ADD CONSTRAINT "incident_person_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_reported_by_user_id_user_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_report" ADD CONSTRAINT "incident_report_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting" ADD CONSTRAINT "safety_meeting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting" ADD CONSTRAINT "safety_meeting_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting" ADD CONSTRAINT "safety_meeting_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting" ADD CONSTRAINT "safety_meeting_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting_attendee" ADD CONSTRAINT "safety_meeting_attendee_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting_attendee" ADD CONSTRAINT "safety_meeting_attendee_meeting_id_safety_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."safety_meeting"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting_attendee" ADD CONSTRAINT "safety_meeting_attendee_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting_attendee" ADD CONSTRAINT "safety_meeting_attendee_signed_by_user_id_user_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_code" ADD CONSTRAINT "oauth_code_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_code" ADD CONSTRAINT "oauth_code_app_id_connected_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."connected_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_code" ADD CONSTRAINT "oauth_code_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_app_id_connected_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."connected_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retention_hold_entity_idx" ON "retention_hold" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retention_purge_run_org_idx" ON "retention_purge_run" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_person_incident_idx" ON "incident_person" USING btree ("organization_id","incident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_report_occurred_idx" ON "incident_report" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_report_status_idx" ON "incident_report" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_meeting_held_idx" ON "safety_meeting" USING btree ("organization_id","held_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_meeting_attendee_meeting_idx" ON "safety_meeting_attendee" USING btree ("organization_id","meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "safety_meeting_attendee_person_idx" ON "safety_meeting_attendee" USING btree ("meeting_id","technician_id") WHERE technician_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_code_hash_idx" ON "oauth_code" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_refresh_token_hash_idx" ON "oauth_refresh_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_family_idx" ON "oauth_refresh_token" USING btree ("organization_id","family_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_app" ADD CONSTRAINT "connected_app_refused_by_user_id_user_id_fk" FOREIGN KEY ("refused_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connected_app_oauth_idx" ON "connected_app" USING btree ("organization_id","oauth_client_id");