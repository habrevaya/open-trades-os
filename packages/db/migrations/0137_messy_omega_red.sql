CREATE TABLE IF NOT EXISTS "contract_billing_fee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"previous_amount" numeric(14, 4) NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contract_billing_schedule" ADD COLUMN "rises_with_escalation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_escalation_notice" ADD COLUMN "fee_draft" numeric(14, 4);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_fee" ADD CONSTRAINT "contract_billing_fee_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_fee" ADD CONSTRAINT "contract_billing_fee_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_billing_fee" ADD CONSTRAINT "contract_billing_fee_schedule_id_contract_billing_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."contract_billing_schedule"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_billing_fee_schedule_idx" ON "contract_billing_fee" USING btree ("schedule_id","effective_from");