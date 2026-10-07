CREATE TYPE "public"."contract_billing_frequency" AS ENUM('monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."contract_billing_period_status" AS ENUM('invoiced', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."contract_billing_state" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."agreement_cancellation_code" AS ENUM('moved', 'sold', 'price', 'service', 'switched', 'not_needed', 'other');--> statement-breakpoint
CREATE TYPE "public"."continuing_education_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."campaign_variant" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."review_request_source" AS ENUM('office', 'automation');--> statement-breakpoint
ALTER TYPE "public"."task_frequency" ADD VALUE 'nth_weekday_of_month';--> statement-breakpoint
ALTER TYPE "public"."task_frequency" ADD VALUE 'every_n_weeks';--> statement-breakpoint
ALTER TYPE "public"."task_frequency" ADD VALUE 'chosen_weekdays';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_billing_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"bill_on" date NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"prorated" boolean DEFAULT false NOT NULL,
	"days" integer NOT NULL,
	"full_days" integer NOT NULL,
	"status" "contract_billing_period_status" NOT NULL,
	"invoice_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_billing_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"frequency" "contract_billing_frequency" DEFAULT 'monthly' NOT NULL,
	"billing_day" integer NOT NULL,
	"starts_on" date NOT NULL,
	"prorate" boolean DEFAULT false NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"state" "contract_billing_state" DEFAULT 'active' NOT NULL,
	"paused_on" date,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "dropped_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "schedule_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "schedule_applied_by" uuid;--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "schedule_applied" jsonb;--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "cancellation_code" "agreement_cancellation_code";--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "status" "continuing_education_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "self_logged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "decided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "technician_skill" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "technician_skill" ADD COLUMN "renewal_lead_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definition" ADD COLUMN "customer_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "month_week" integer;--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "interval_weeks" integer;--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "days_of_week" integer[];--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD COLUMN "variant" "campaign_variant" DEFAULT 'a' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_b_body" text;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_b_subject" text;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "source" "review_request_source" DEFAULT 'office' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_object_record" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_object_record" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_object_record" ADD COLUMN "linked_record_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_object_type" ADD COLUMN "record_kind" text;--> statement-breakpoint
ALTER TABLE "custom_object_type" ADD COLUMN "customer_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_period" ADD CONSTRAINT "contract_billing_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_period" ADD CONSTRAINT "contract_billing_period_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_period" ADD CONSTRAINT "contract_billing_period_schedule_id_contract_billing_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."contract_billing_schedule"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_period" ADD CONSTRAINT "contract_billing_period_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_schedule" ADD CONSTRAINT "contract_billing_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_schedule" ADD CONSTRAINT "contract_billing_schedule_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_billing_period_idx" ON "contract_billing_period" USING btree ("contract_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_billing_period_schedule_idx" ON "contract_billing_period" USING btree ("schedule_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_billing_schedule_contract_idx" ON "contract_billing_schedule" USING btree ("contract_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order" ADD CONSTRAINT "project_change_order_schedule_applied_by_user_id_fk" FOREIGN KEY ("schedule_applied_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "continuing_education" ADD CONSTRAINT "continuing_education_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_linked_record_id_custom_object_record_id_fk" FOREIGN KEY ("linked_record_id") REFERENCES "public"."custom_object_record"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_invoice_idx" ON "custom_object_record" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_membership_idx" ON "custom_object_record" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_linked_idx" ON "custom_object_record" USING btree ("linked_record_id");