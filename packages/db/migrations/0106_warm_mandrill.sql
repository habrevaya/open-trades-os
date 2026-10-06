CREATE TYPE "public"."contract_billing_frequency" AS ENUM('monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."contract_billing_period_status" AS ENUM('invoiced', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."contract_billing_state" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
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
CREATE UNIQUE INDEX IF NOT EXISTS "contract_billing_schedule_contract_idx" ON "contract_billing_schedule" USING btree ("contract_id");