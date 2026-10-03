CREATE TYPE "public"."claim_status" AS ENUM('submitted', 'approved', 'paid', 'short_paid', 'denied');--> statement-breakpoint
CREATE TYPE "public"."labour_band" AS ENUM('standard', 'after_hours', 'weekend', 'holiday');--> statement-breakpoint
ALTER TYPE "public"."portal_grant_scope" ADD VALUE 'payer';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coverage_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payer_customer_id" uuid NOT NULL,
	"source" "coverage_source" NOT NULL,
	"status" "claim_status" DEFAULT 'submitted' NOT NULL,
	"claimed_amount" numeric(14, 4) NOT NULL,
	"approved_amount" numeric(14, 4),
	"paid_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"external_reference" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_card_labour_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rate_card_id" uuid NOT NULL,
	"job_type_id" uuid,
	"band" "labour_band" DEFAULT 'standard' NOT NULL,
	"hourly_rate" numeric(14, 4) NOT NULL,
	"minimum_minutes" integer,
	"increment_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "trip_charge" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "material_markup" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "standard_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "standard_start_minute" integer DEFAULT 480 NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "standard_end_minute" integer DEFAULT 1020 NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "holidays" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_contract" ADD COLUMN "not_to_exceed_action" text DEFAULT 'hold' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_contract" ADD COLUMN "invoice_within_days" integer;--> statement-breakpoint
ALTER TABLE "service_contract" ADD COLUMN "claim_within_days" integer;--> statement-breakpoint
ALTER TABLE "service_contract" ADD COLUMN "invoice_format" text;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "price_authority" text;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "rate_card_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "price_basis" text;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "price_note" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverage_claim" ADD CONSTRAINT "coverage_claim_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverage_claim" ADD CONSTRAINT "coverage_claim_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverage_claim" ADD CONSTRAINT "coverage_claim_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverage_claim" ADD CONSTRAINT "coverage_claim_payer_customer_id_customer_id_fk" FOREIGN KEY ("payer_customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card_labour_rate" ADD CONSTRAINT "rate_card_labour_rate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card_labour_rate" ADD CONSTRAINT "rate_card_labour_rate_rate_card_id_rate_card_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card_labour_rate" ADD CONSTRAINT "rate_card_labour_rate_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coverage_claim_invoice_idx" ON "coverage_claim" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coverage_claim_status_idx" ON "coverage_claim" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coverage_claim_job_idx" ON "coverage_claim" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_card_labour_rate_card_idx" ON "rate_card_labour_rate" USING btree ("rate_card_id");