CREATE TYPE "public"."project_application_status" AS ENUM('draft', 'invoiced');--> statement-breakpoint
CREATE TYPE "public"."project_change_order_status" AS ENUM('requested', 'priced', 'sent', 'approved', 'declined', 'void');--> statement-breakpoint
CREATE TYPE "public"."project_lien_record_direction" AS ENUM('sent', 'received');--> statement-breakpoint
CREATE TYPE "public"."project_lien_record_kind" AS ENUM('notice', 'waiver');--> statement-breakpoint
CREATE TYPE "public"."project_waiver_condition" AS ENUM('conditional', 'unconditional');--> statement-breakpoint
CREATE TYPE "public"."project_waiver_scope" AS ENUM('progress', 'final');--> statement-breakpoint
ALTER TYPE "public"."signature_subject" ADD VALUE 'change_order';--> statement-breakpoint
ALTER TYPE "public"."portal_grant_scope" ADD VALUE 'change_order';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"period_from" date,
	"period_to" date NOT NULL,
	"status" "project_application_status" DEFAULT 'draft' NOT NULL,
	"retainage_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"stored_retainage_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"retainage_released" numeric(14, 4) DEFAULT '0' NOT NULL,
	"notes" text,
	"contract_sum" numeric(14, 4),
	"net_change_orders" numeric(14, 4),
	"total_completed_and_stored" numeric(14, 4),
	"total_retainage" numeric(14, 4),
	"total_earned_less_retainage" numeric(14, 4),
	"previous_certificates" numeric(14, 4),
	"current_payment_due" numeric(14, 4),
	"invoice_id" uuid,
	"invoiced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_application_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"project_phase_id" uuid,
	"change_order_id" uuid,
	"description" text NOT NULL,
	"scheduled_value" numeric(14, 4) NOT NULL,
	"previous_work" numeric(14, 4) DEFAULT '0' NOT NULL,
	"previous_stored" numeric(14, 4) DEFAULT '0' NOT NULL,
	"work_this_period" numeric(14, 4) DEFAULT '0' NOT NULL,
	"stored_now" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_change_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"requested_by" text,
	"reason" text,
	"status" "project_change_order_status" DEFAULT 'requested' NOT NULL,
	"project_phase_id" uuid,
	"schedule_days" integer,
	"amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"cost" numeric(14, 4),
	"sent_at" timestamp with time zone,
	"document_hash" text,
	"decided_at" timestamp with time zone,
	"decided_via" text,
	"signer_name" text,
	"decline_reason" text,
	"contract_value_before" numeric(14, 4),
	"contract_value_after" numeric(14, 4),
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_change_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"change_order_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"price_book_item_id" uuid,
	"price_book_item_version_id" uuid,
	"rate_card_id" uuid,
	"price_source" text DEFAULT 'manual' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4),
	"line_total" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_lien_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "project_lien_record_kind" NOT NULL,
	"direction" "project_lien_record_direction" NOT NULL,
	"condition" "project_waiver_condition",
	"scope" "project_waiver_scope",
	"title" text NOT NULL,
	"party_name" text NOT NULL,
	"on_date" date NOT NULL,
	"through_date" date,
	"amount" numeric(14, 4),
	"invoice_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "retainage_rate" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "checkpoints" jsonb;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "answers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "statement" text;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "signed_by_name" text;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "signature_upload_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application" ADD CONSTRAINT "project_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application" ADD CONSTRAINT "project_application_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application" ADD CONSTRAINT "project_application_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application_line" ADD CONSTRAINT "project_application_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application_line" ADD CONSTRAINT "project_application_line_application_id_project_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."project_application"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application_line" ADD CONSTRAINT "project_application_line_project_phase_id_project_phase_id_fk" FOREIGN KEY ("project_phase_id") REFERENCES "public"."project_phase"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_application_line" ADD CONSTRAINT "project_application_line_change_order_id_project_change_order_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."project_change_order"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order" ADD CONSTRAINT "project_change_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order" ADD CONSTRAINT "project_change_order_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order" ADD CONSTRAINT "project_change_order_project_phase_id_project_phase_id_fk" FOREIGN KEY ("project_phase_id") REFERENCES "public"."project_phase"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_line" ADD CONSTRAINT "project_change_order_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_line" ADD CONSTRAINT "project_change_order_line_change_order_id_project_change_order_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."project_change_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_lien_record" ADD CONSTRAINT "project_lien_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_lien_record" ADD CONSTRAINT "project_lien_record_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_lien_record" ADD CONSTRAINT "project_lien_record_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_application_number_idx" ON "project_application" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_application_project_idx" ON "project_application" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_application_line_application_idx" ON "project_application_line" USING btree ("application_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_change_order_number_idx" ON "project_change_order" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_change_order_project_idx" ON "project_change_order" USING btree ("organization_id","project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_change_order_line_order_idx" ON "project_change_order_line" USING btree ("change_order_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_lien_record_project_idx" ON "project_lien_record" USING btree ("organization_id","project_id","on_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_lien_record_invoice_idx" ON "project_lien_record" USING btree ("invoice_id");