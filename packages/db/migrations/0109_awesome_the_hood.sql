CREATE TYPE "public"."plugin_kind" AS ENUM('job_workflow', 'pricing_rule', 'report_type');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_plugin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid,
	"app_name" text NOT NULL,
	"kind" "plugin_kind" NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"job_type_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_plugin_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "pricing_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "pricing_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_plugin" ADD CONSTRAINT "app_plugin_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_plugin" ADD CONSTRAINT "app_plugin_app_id_connected_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."connected_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_plugin" ADD CONSTRAINT "app_plugin_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_plugin_version" ADD CONSTRAINT "app_plugin_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_plugin_version" ADD CONSTRAINT "app_plugin_version_plugin_id_app_plugin_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."app_plugin"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_plugin_key_idx" ON "app_plugin" USING btree ("organization_id","app_id","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_plugin_job_type_idx" ON "app_plugin" USING btree ("organization_id","job_type_id") WHERE kind = 'job_workflow' and retired_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_plugin_app_idx" ON "app_plugin" USING btree ("organization_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_plugin_version_idx" ON "app_plugin_version" USING btree ("plugin_id","version");