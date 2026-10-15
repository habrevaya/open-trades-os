CREATE TYPE "public"."route_day_status" AS ENUM('counted', 'gap', 'no_route');--> statement-breakpoint
CREATE TYPE "public"."permit_failure_scope" AS ENUM('our_work', 'outside_our_work');--> statement-breakpoint
CREATE TYPE "public"."permit_inspection_result" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"day" date NOT NULL,
	"stops" integer NOT NULL,
	"drives" integer NOT NULL,
	"miles" numeric(10, 3) NOT NULL,
	"fixes" integer NOT NULL,
	"status" "route_day_status" NOT NULL,
	"note" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permit_inspection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"permit_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"inspected_on" date NOT NULL,
	"stage" text,
	"result" "permit_inspection_result" NOT NULL,
	"failure_scope" "permit_failure_scope",
	"findings" text,
	"inspector_name" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permit_inspection_scope_on_fail" CHECK (("permit_inspection"."result" = 'failed') = ("permit_inspection"."failure_scope" is not null)),
	CONSTRAINT "permit_inspection_findings_on_fail" CHECK ("permit_inspection"."result" <> 'failed' or ("permit_inspection"."findings" is not null and length(trim("permit_inspection"."findings")) > 0))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_day" ADD CONSTRAINT "route_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_day" ADD CONSTRAINT "route_day_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permit_inspection" ADD CONSTRAINT "permit_inspection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permit_inspection" ADD CONSTRAINT "permit_inspection_permit_id_compliance_document_id_fk" FOREIGN KEY ("permit_id") REFERENCES "public"."compliance_document"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permit_inspection" ADD CONSTRAINT "permit_inspection_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permit_inspection" ADD CONSTRAINT "permit_inspection_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_day_person_day_idx" ON "route_day" USING btree ("technician_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_day_day_idx" ON "route_day" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_inspection_job_idx" ON "permit_inspection" USING btree ("organization_id","job_id","inspected_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_inspection_permit_idx" ON "permit_inspection" USING btree ("permit_id");