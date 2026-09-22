CREATE TYPE "public"."operation_status" AS ENUM('accepted', 'applied', 'conflicted', 'rejected', 'superseded', 'held');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('queued', 'uploading', 'stored', 'failed', 'abandoned');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "arrival_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eta_minutes" integer,
	"arrived_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_reason" text,
	"includes_tracking" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"label" text,
	"platform" text,
	"app_version" text,
	"os_version" text,
	"push_token" text,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"clamped" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"status" "operation_status" DEFAULT 'accepted' NOT NULL,
	"conflict" text,
	"rejection" text,
	"superseded_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"latitude" text,
	"longitude" text,
	"accuracy_meters" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid,
	"operation_id" uuid,
	"client_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"status" "upload_status" DEFAULT 'queued' NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer,
	"content_hash" text,
	"storage_key" text,
	"caption" text,
	"captured_at" timestamp with time zone,
	"latitude" text,
	"longitude" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"stored_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "arrival_notice" ADD CONSTRAINT "arrival_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device" ADD CONSTRAINT "device_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device" ADD CONSTRAINT "device_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_snapshot" ADD CONSTRAINT "device_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_snapshot" ADD CONSTRAINT "device_snapshot_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_operation" ADD CONSTRAINT "field_operation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_operation" ADD CONSTRAINT "field_operation_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_operation" ADD CONSTRAINT "field_operation_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_upload" ADD CONSTRAINT "field_upload_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_upload" ADD CONSTRAINT "field_upload_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "field_upload" ADD CONSTRAINT "field_upload_operation_id_field_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."field_operation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "arrival_notice_visit_idx" ON "arrival_notice" USING btree ("visit_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "arrival_notice_org_idx" ON "arrival_notice" USING btree ("organization_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_org_idx" ON "device" USING btree ("organization_id","technician_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_installation_idx" ON "device" USING btree ("organization_id","installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_snapshot_device_idx" ON "device_snapshot" USING btree ("device_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_operation_client_idx" ON "field_operation" USING btree ("organization_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_operation_device_seq_idx" ON "field_operation" USING btree ("device_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_operation_subject_idx" ON "field_operation" USING btree ("organization_id","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_operation_conflict_idx" ON "field_operation" USING btree ("organization_id","status","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_upload_client_idx" ON "field_upload" USING btree ("organization_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_upload_subject_idx" ON "field_upload" USING btree ("organization_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_upload_pending_idx" ON "field_upload" USING btree ("organization_id","status","attempts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_upload_hash_idx" ON "field_upload" USING btree ("organization_id","content_hash");