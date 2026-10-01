CREATE TYPE "public"."project_phase_status" AS ENUM('not_started', 'in_progress', 'blocked', 'complete');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planning', 'active', 'on_hold', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."certification_status" AS ENUM('active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" "project_status" DEFAULT 'planning' NOT NULL,
	"starts_on" date,
	"target_completion_on" date,
	"completed_at" timestamp with time zone,
	"contract_value" numeric(14, 4),
	"budget_cost" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_draw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_phase_id" uuid,
	"sequence" integer NOT NULL,
	"label" text NOT NULL,
	"percent" numeric(9, 6),
	"amount" numeric(14, 4) NOT NULL,
	"invoice_id" uuid,
	"raised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_phase_id" uuid,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_phase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "project_phase_status" DEFAULT 'not_started' NOT NULL,
	"depends_on_phase_id" uuid,
	"billing_value" numeric(14, 4),
	"budget_cost" numeric(14, 4),
	"starts_on" date,
	"ends_on" date,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "certification_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"authority" text,
	"grants_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires" boolean DEFAULT true NOT NULL,
	"default_valid_months" integer,
	"renewal_lead_days" integer DEFAULT 60 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_certification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"certification_type_id" uuid NOT NULL,
	"reference" text,
	"issued_on" date,
	"expires_on" date,
	"status" "certification_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"verification_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project" ADD CONSTRAINT "project_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project" ADD CONSTRAINT "project_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project" ADD CONSTRAINT "project_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_draw" ADD CONSTRAINT "project_draw_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_draw" ADD CONSTRAINT "project_draw_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_draw" ADD CONSTRAINT "project_draw_project_phase_id_project_phase_id_fk" FOREIGN KEY ("project_phase_id") REFERENCES "public"."project_phase"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_draw" ADD CONSTRAINT "project_draw_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_job" ADD CONSTRAINT "project_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_job" ADD CONSTRAINT "project_job_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_job" ADD CONSTRAINT "project_job_project_phase_id_project_phase_id_fk" FOREIGN KEY ("project_phase_id") REFERENCES "public"."project_phase"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_job" ADD CONSTRAINT "project_job_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_phase" ADD CONSTRAINT "project_phase_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_phase" ADD CONSTRAINT "project_phase_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "certification_type" ADD CONSTRAINT "certification_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_certification" ADD CONSTRAINT "person_certification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_certification" ADD CONSTRAINT "person_certification_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_certification" ADD CONSTRAINT "person_certification_certification_type_id_certification_type_id_fk" FOREIGN KEY ("certification_type_id") REFERENCES "public"."certification_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_certification" ADD CONSTRAINT "person_certification_verified_by_user_id_user_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_org_idx" ON "project" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_customer_idx" ON "project" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_draw_sequence_idx" ON "project_draw" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_draw_project_idx" ON "project_draw" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_job_job_idx" ON "project_job" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_job_project_idx" ON "project_job" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_job_phase_idx" ON "project_job" USING btree ("project_phase_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_phase_sequence_idx" ON "project_phase" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_phase_project_idx" ON "project_phase" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "certification_type_code_idx" ON "certification_type" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "certification_type_org_idx" ON "certification_type" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_certification_person_idx" ON "person_certification" USING btree ("organization_id","technician_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_certification_expiry_idx" ON "person_certification" USING btree ("organization_id","expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "person_certification_reference_idx" ON "person_certification" USING btree ("technician_id","certification_type_id","reference") WHERE "person_certification"."reference" is not null;