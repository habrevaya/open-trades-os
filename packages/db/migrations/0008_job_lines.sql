CREATE TYPE "public"."job_line_kind" AS ENUM('part', 'labor', 'equipment', 'subcontractor', 'disposal', 'permit', 'other');--> statement-breakpoint
CREATE TYPE "public"."job_line_source" AS ENUM('field', 'office', 'import');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"visit_id" uuid,
	"kind" "job_line_kind" DEFAULT 'part' NOT NULL,
	"source" "job_line_source" DEFAULT 'office' NOT NULL,
	"price_book_item_version_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(14, 4),
	"taxable" boolean DEFAULT true NOT NULL,
	"technician_id" uuid,
	"invoice_line_id" uuid,
	"non_billable_reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_line" ADD CONSTRAINT "job_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_line" ADD CONSTRAINT "job_line_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_line" ADD CONSTRAINT "job_line_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_line" ADD CONSTRAINT "job_line_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_line_job_idx" ON "job_line" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_line_visit_idx" ON "job_line" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_line_unbilled_idx" ON "job_line" USING btree ("organization_id","invoice_line_id");