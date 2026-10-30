CREATE TABLE IF NOT EXISTS "contract_work_difference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"rate_card_id" uuid NOT NULL,
	"anniversary" date NOT NULL,
	"status" "contract_billing_difference_status" NOT NULL,
	"invoice_id" uuid,
	"risen_price" numeric(14, 4) NOT NULL,
	"billed_amount" numeric(14, 4) NOT NULL,
	"risen_amount" numeric(14, 4) NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX IF EXISTS "card_on_file_charge_autopay_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "payment_agreement_autopay_idx";--> statement-breakpoint
ALTER TABLE "card_on_file_charge" ADD COLUMN "card_rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "autopay_rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_work_difference" ADD CONSTRAINT "contract_work_difference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_work_difference" ADD CONSTRAINT "contract_work_difference_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_work_difference" ADD CONSTRAINT "contract_work_difference_invoice_line_id_invoice_line_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_line"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_work_difference" ADD CONSTRAINT "contract_work_difference_rate_card_id_rate_card_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_work_difference" ADD CONSTRAINT "contract_work_difference_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_work_difference_line_idx" ON "contract_work_difference" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_work_difference_contract_idx" ON "contract_work_difference" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_on_file_charge_autopay_idx" ON "card_on_file_charge" USING btree ("organization_id","invoice_id","attempt","card_rank") WHERE "card_on_file_charge"."trigger" = 'autopay';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_agreement_autopay_idx" ON "payment_agreement" USING btree ("organization_id","customer_id","autopay_rank") WHERE "payment_agreement"."withdrawn_at" is null and "payment_agreement"."autopay_at" is not null;