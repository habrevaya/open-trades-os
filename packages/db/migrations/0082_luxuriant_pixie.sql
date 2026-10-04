CREATE TYPE "public"."costing_basis" AS ENUM('percent_of_wages', 'per_hour', 'per_job', 'percent_of_revenue');--> statement-breakpoint
CREATE TYPE "public"."costing_component" AS ENUM('payroll_taxes', 'benefits', 'workers_comp', 'overhead');--> statement-breakpoint
CREATE TYPE "public"."financing_status" AS ENUM('sent', 'applied', 'approved', 'declined', 'expired', 'funded', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."accounting_entity_kind" ADD VALUE 'journal';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"line" text NOT NULL,
	"month" integer NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_line_month" CHECK ("budget_line"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "costing_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"component" "costing_component" NOT NULL,
	"basis" "costing_basis" NOT NULL,
	"rate" numeric(14, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "financing_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid,
	"estimate_id" uuid,
	"estimate_option_id" uuid,
	"status" "financing_status" DEFAULT 'sent' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"external_id" text NOT NULL,
	"application_url" text NOT NULL,
	"approved_amount" numeric(14, 4),
	"chosen_offer" jsonb,
	"funded_amount" numeric(14, 4),
	"fee_amount" numeric(14, 4),
	"funded_at" timestamp with time zone,
	"payment_id" uuid,
	"sent_via" text NOT NULL,
	"sent_to" text,
	"expires_at" timestamp with time zone,
	"attention" text,
	"last_event_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financing_application_subject" CHECK (("financing_application"."invoice_id" is not null) <> ("financing_application"."estimate_id" is not null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"occurred_on" date NOT NULL,
	"memo" text NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"total" numeric(14, 4) NOT NULL,
	"reverses_journal_id" uuid,
	"ledger_transaction_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget" ADD CONSTRAINT "budget_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_budget_id_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budget"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "costing_rate" ADD CONSTRAINT "costing_rate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "costing_rate" ADD CONSTRAINT "costing_rate_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financing_application" ADD CONSTRAINT "financing_application_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_year_idx" ON "budget" USING btree ("organization_id","year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_cell_idx" ON "budget_line" USING btree ("budget_id","line","month");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "costing_rate_day_idx" ON "costing_rate" USING btree ("organization_id","component","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "financing_application_external_idx" ON "financing_application" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financing_application_invoice_idx" ON "financing_application" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financing_application_estimate_idx" ON "financing_application" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financing_application_org_idx" ON "financing_application" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journal_entry_number_idx" ON "journal_entry" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journal_entry_reverses_idx" ON "journal_entry" USING btree ("reverses_journal_id") WHERE reverses_journal_id is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entry_org_idx" ON "journal_entry" USING btree ("organization_id","occurred_on");