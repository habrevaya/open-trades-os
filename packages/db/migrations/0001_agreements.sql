CREATE TYPE "public"."agreement_status" AS ENUM('pending', 'active', 'past_due', 'paused', 'lapsed', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."billing_frequency" AS ENUM('monthly', 'quarterly', 'semiannual', 'annual', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."billing_schedule_status" AS ENUM('scheduled', 'invoiced', 'paid', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."recurrence_model" AS ENUM('rule', 'materialized', 'anchored_to_completion', 'manual');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agreement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"equipment_id" uuid,
	"status" "agreement_status" DEFAULT 'pending' NOT NULL,
	"started_on" date NOT NULL,
	"ends_on" date,
	"cancelled_on" date,
	"cancellation_reason" text,
	"price" numeric(14, 4) NOT NULL,
	"billing_frequency" "billing_frequency" NOT NULL,
	"auto_renews" boolean DEFAULT true NOT NULL,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"renewal_notice_sent_at" timestamp with time zone,
	"visit_schedule_id" uuid,
	"visits_included_this_term" integer DEFAULT 0 NOT NULL,
	"visits_delivered_this_term" integer DEFAULT 0 NOT NULL,
	"processor_subscription_id" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agreement_billing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"due_on" date NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"status" "billing_schedule_status" DEFAULT 'scheduled' NOT NULL,
	"invoice_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agreement_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"business_unit_id" uuid,
	"price" numeric(14, 4) NOT NULL,
	"billing_frequency" "billing_frequency" DEFAULT 'monthly' NOT NULL,
	"term_months" integer DEFAULT 12 NOT NULL,
	"auto_renews" boolean DEFAULT true NOT NULL,
	"renewal_notice_days" integer DEFAULT 30 NOT NULL,
	"included_visits_per_term" integer DEFAULT 0 NOT NULL,
	"visit_job_type_id" uuid,
	"visit_recurrence_model" "recurrence_model" DEFAULT 'rule' NOT NULL,
	"visit_interval_days" integer,
	"visit_anchor_months" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discount_rate" numeric(9, 6),
	"priority_dispatch" boolean DEFAULT false NOT NULL,
	"waives_diagnostic_fee" boolean DEFAULT false NOT NULL,
	"waives_after_hours_rate" boolean DEFAULT false NOT NULL,
	"extended_warranty_months" integer,
	"benefits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deferred_account_code" text,
	"revenue_account_code" text,
	"trade_pack_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agreement_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"due_on" date NOT NULL,
	"window_start_on" date,
	"window_end_on" date,
	"job_id" uuid,
	"delivered_on" date,
	"skipped_on" date,
	"skip_reason" text,
	"recognition_amount" numeric(14, 4),
	"recognized_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deferred_revenue_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid,
	"agreement_visit_id" uuid,
	"invoice_id" uuid,
	"amount" numeric(14, 4) NOT NULL,
	"scheduled_for" date NOT NULL,
	"recognized_on" date,
	"ledger_transaction_id" uuid,
	"released_on" date,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"model" "recurrence_model" DEFAULT 'rule' NOT NULL,
	"rule" text,
	"friendly" text,
	"interval_days" integer,
	"anchor_months" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"last_occurred_on" date,
	"next_due_on" date,
	"horizon_months" integer DEFAULT 12 NOT NULL,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement" ADD CONSTRAINT "agreement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement" ADD CONSTRAINT "agreement_plan_id_agreement_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."agreement_plan"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement" ADD CONSTRAINT "agreement_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement" ADD CONSTRAINT "agreement_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement" ADD CONSTRAINT "agreement_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement" ADD CONSTRAINT "agreement_visit_schedule_id_recurring_schedule_id_fk" FOREIGN KEY ("visit_schedule_id") REFERENCES "public"."recurring_schedule"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_billing" ADD CONSTRAINT "agreement_billing_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_billing" ADD CONSTRAINT "agreement_billing_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_billing" ADD CONSTRAINT "agreement_billing_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_plan" ADD CONSTRAINT "agreement_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_plan" ADD CONSTRAINT "agreement_plan_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_visit" ADD CONSTRAINT "agreement_visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_visit" ADD CONSTRAINT "agreement_visit_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_visit" ADD CONSTRAINT "agreement_visit_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferred_revenue_entry" ADD CONSTRAINT "deferred_revenue_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferred_revenue_entry" ADD CONSTRAINT "deferred_revenue_entry_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferred_revenue_entry" ADD CONSTRAINT "deferred_revenue_entry_agreement_visit_id_agreement_visit_id_fk" FOREIGN KEY ("agreement_visit_id") REFERENCES "public"."agreement_visit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferred_revenue_entry" ADD CONSTRAINT "deferred_revenue_entry_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_customer_idx" ON "agreement" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_renewal_idx" ON "agreement" USING btree ("organization_id","status","ends_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_property_idx" ON "agreement" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_billing_agreement_idx" ON "agreement_billing" USING btree ("agreement_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_billing_due_idx" ON "agreement_billing" USING btree ("organization_id","status","due_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_plan_org_idx" ON "agreement_plan" USING btree ("organization_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_plan_code_idx" ON "agreement_plan" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_visit_agreement_idx" ON "agreement_visit" USING btree ("agreement_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_visit_owed_idx" ON "agreement_visit" USING btree ("organization_id","due_on","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferred_revenue_open_idx" ON "deferred_revenue_entry" USING btree ("organization_id","recognized_on","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferred_revenue_agreement_idx" ON "deferred_revenue_entry" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_schedule_due_idx" ON "recurring_schedule" USING btree ("organization_id","active","next_due_on");