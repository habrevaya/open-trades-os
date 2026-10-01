CREATE TYPE "public"."commission_basis" AS ENUM('percent_of_revenue', 'percent_of_gross_margin', 'flat_per_job', 'percent_of_collected');--> statement-breakpoint
CREATE TYPE "public"."commission_entry_kind" AS ENUM('earned', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."commission_reversal_reason" AS ENUM('refund', 'credit_note', 'write_off', 'callback');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"reversal_id" uuid,
	"technician_id" uuid NOT NULL,
	"kind" "commission_entry_kind" NOT NULL,
	"weight" numeric(9, 6),
	"share_index" integer NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"explanation" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_in_period_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid,
	"invoice_id" uuid NOT NULL,
	"job_id" uuid,
	"basis" "commission_basis" NOT NULL,
	"applied_rate" numeric(9, 6),
	"applied_flat_amount" numeric(14, 4),
	"revenue" numeric(14, 4) NOT NULL,
	"cost" numeric(14, 4),
	"collected" numeric(14, 4),
	"total" numeric(14, 4) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"explanation" text NOT NULL,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"basis" "commission_basis" NOT NULL,
	"rate" numeric(9, 6),
	"flat_amount" numeric(14, 4),
	"note" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_reversal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"reason" "commission_reversal_reason" NOT NULL,
	"credited_revenue" numeric(14, 4) NOT NULL,
	"credited_cost" numeric(14, 4),
	"total" numeric(14, 4) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"explanation" text NOT NULL,
	"cause_type" text NOT NULL,
	"cause_id" uuid NOT NULL,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pay_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"start_date" date NOT NULL,
	"weeks" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pay_period_close" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pay_period_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_user_id" uuid,
	"note" text,
	"hours_fingerprint" text NOT NULL,
	"reopened_at" timestamp with time zone,
	"reopened_by_user_id" uuid,
	"reopened_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pay_period_id" uuid NOT NULL,
	"close_id" uuid NOT NULL,
	"format" text NOT NULL,
	"row_count" integer NOT NULL,
	"gross_total" numeric(14, 4) NOT NULL,
	"checksum" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_entry" ADD CONSTRAINT "commission_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_entry" ADD CONSTRAINT "commission_entry_event_id_commission_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."commission_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_entry" ADD CONSTRAINT "commission_entry_reversal_id_commission_reversal_id_fk" FOREIGN KEY ("reversal_id") REFERENCES "public"."commission_reversal"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_entry" ADD CONSTRAINT "commission_entry_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_event" ADD CONSTRAINT "commission_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_event" ADD CONSTRAINT "commission_event_plan_id_commission_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."commission_plan"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_event" ADD CONSTRAINT "commission_event_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_event" ADD CONSTRAINT "commission_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_plan" ADD CONSTRAINT "commission_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_reversal" ADD CONSTRAINT "commission_reversal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_reversal" ADD CONSTRAINT "commission_reversal_event_id_commission_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."commission_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_period" ADD CONSTRAINT "pay_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_period_close" ADD CONSTRAINT "pay_period_close_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_period_close" ADD CONSTRAINT "pay_period_close_pay_period_id_pay_period_id_fk" FOREIGN KEY ("pay_period_id") REFERENCES "public"."pay_period"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_period_close" ADD CONSTRAINT "pay_period_close_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pay_period_close" ADD CONSTRAINT "pay_period_close_reopened_by_user_id_user_id_fk" FOREIGN KEY ("reopened_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_pay_period_id_pay_period_id_fk" FOREIGN KEY ("pay_period_id") REFERENCES "public"."pay_period"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_close_id_pay_period_close_id_fk" FOREIGN KEY ("close_id") REFERENCES "public"."pay_period_close"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_export" ADD CONSTRAINT "payroll_export_generated_by_user_id_user_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_entry_person_idx" ON "commission_entry" USING btree ("organization_id","technician_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_entry_event_idx" ON "commission_entry" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_entry_unpaid_idx" ON "commission_entry" USING btree ("organization_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_event_invoice_idx" ON "commission_event" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_event_occurred_idx" ON "commission_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_plan_org_idx" ON "commission_plan" USING btree ("organization_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_reversal_cause_idx" ON "commission_reversal" USING btree ("event_id","cause_type","cause_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_reversal_occurred_idx" ON "commission_reversal" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pay_period_start_idx" ON "pay_period" USING btree ("organization_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pay_period_close_live_idx" ON "pay_period_close" USING btree ("pay_period_id") WHERE "pay_period_close"."reopened_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pay_period_close_period_idx" ON "pay_period_close" USING btree ("organization_id","pay_period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_export_period_idx" ON "payroll_export" USING btree ("organization_id","pay_period_id");