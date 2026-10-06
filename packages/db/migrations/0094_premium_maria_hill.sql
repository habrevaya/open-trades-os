CREATE TABLE IF NOT EXISTS "backup_destination" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_key_ref" text NOT NULL,
	"path_style" boolean DEFAULT true NOT NULL,
	"frequency" text DEFAULT 'daily' NOT NULL,
	"hour" integer DEFAULT 2 NOT NULL,
	"weekday" integer,
	"keep" integer DEFAULT 14 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"destination_id" uuid,
	"trigger" text NOT NULL,
	"requested_by_user_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"rows" integer,
	"files" integer,
	"error" text,
	"pruned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "restore_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"source" text NOT NULL,
	"source_name" text NOT NULL,
	"source_sha256" text,
	"source_bytes" bigint,
	"format" text,
	"dry_run" boolean NOT NULL,
	"outcome" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stored_file" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_file" ADD COLUMN "stored_in" text DEFAULT 'postgres' NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_file" ADD COLUMN "object_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_destination_id_backup_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destination"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restore_run" ADD CONSTRAINT "restore_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restore_run" ADD CONSTRAINT "restore_run_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backup_destination_org_idx" ON "backup_destination" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_destination_due_idx" ON "backup_destination" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_run_org_idx" ON "backup_run" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restore_run_org_idx" ON "restore_run" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stored_file_object_sweep_idx" ON "stored_file" USING btree ("stored_in","deleted_at");--> statement-breakpoint
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_where" CHECK (("stored_file"."stored_in" = 'postgres' and "stored_file"."bytes" is not null and "stored_file"."object_key" is null)
    or ("stored_file"."stored_in" = 'object' and "stored_file"."bytes" is null and "stored_file"."object_key" is not null));