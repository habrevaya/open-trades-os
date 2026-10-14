CREATE TABLE IF NOT EXISTS "contract_escalation_rise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_year" integer,
	"rate_card_id" uuid,
	"job_type_id" uuid,
	"rate" numeric(9, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contract_escalation_notice" ADD COLUMN "key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_escalation_rise" ADD CONSTRAINT "contract_escalation_rise_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_escalation_rise" ADD CONSTRAINT "contract_escalation_rise_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_escalation_rise" ADD CONSTRAINT "contract_escalation_rise_rate_card_id_rate_card_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_escalation_rise" ADD CONSTRAINT "contract_escalation_rise_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_escalation_rise_contract_idx" ON "contract_escalation_rise" USING btree ("contract_id");