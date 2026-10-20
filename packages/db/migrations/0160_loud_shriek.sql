CREATE TYPE "public"."contract_billing_difference_status" AS ENUM('drafted', 'waived');--> statement-breakpoint
ALTER TYPE "public"."budget_forecast_method" ADD VALUE 'seasonal';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_billing_difference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"fee_id" uuid NOT NULL,
	"status" "contract_billing_difference_status" NOT NULL,
	"invoice_id" uuid,
	"billed_amount" numeric(14, 4) NOT NULL,
	"risen_amount" numeric(14, 4) NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "budget_line" DROP CONSTRAINT "budget_line_one_scope";--> statement-breakpoint
DROP INDEX IF EXISTS "budget_line_branch_cell_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "budget_line_job_type_cell_idx";--> statement-breakpoint
ALTER TABLE "price_book_item_version" ADD COLUMN "buy_unit" text;--> statement-breakpoint
ALTER TABLE "price_book_item_version" ADD COLUMN "use_unit" text;--> statement-breakpoint
ALTER TABLE "price_book_item_version" ADD COLUMN "use_per_buy" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "contract_billing_fee" ADD COLUMN "rise_amount" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "contract_escalation_rise" ADD COLUMN "amount" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "contract_escalation_rise" ADD COLUMN "fee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_difference" ADD CONSTRAINT "contract_billing_difference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_difference" ADD CONSTRAINT "contract_billing_difference_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_difference" ADD CONSTRAINT "contract_billing_difference_period_id_contract_billing_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."contract_billing_period"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_difference" ADD CONSTRAINT "contract_billing_difference_fee_id_contract_billing_fee_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."contract_billing_fee"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_difference" ADD CONSTRAINT "contract_billing_difference_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_billing_difference_period_idx" ON "contract_billing_difference" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_billing_difference_contract_idx" ON "contract_billing_difference" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_branch_job_type_cell_idx" ON "budget_line" USING btree ("budget_id","business_unit_id","job_type_id","line","month") WHERE "budget_line"."business_unit_id" is not null and "budget_line"."job_type_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_branch_cell_idx" ON "budget_line" USING btree ("budget_id","business_unit_id","line","month") WHERE "budget_line"."business_unit_id" is not null and "budget_line"."job_type_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_job_type_cell_idx" ON "budget_line" USING btree ("budget_id","job_type_id","line","month") WHERE "budget_line"."job_type_id" is not null and "budget_line"."business_unit_id" is null;