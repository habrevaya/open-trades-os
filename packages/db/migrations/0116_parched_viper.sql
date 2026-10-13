CREATE TABLE IF NOT EXISTS "contract_escalation_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"anniversary" date NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"task_id" uuid,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "draft_for" date;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_escalation_notice" ADD CONSTRAINT "contract_escalation_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_escalation_notice" ADD CONSTRAINT "contract_escalation_notice_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_escalation_notice_once_idx" ON "contract_escalation_notice" USING btree ("organization_id","contract_id","anniversary");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rate_card_draft_idx" ON "rate_card" USING btree ("organization_id","escalated_from_id","draft_for") WHERE "rate_card"."draft_for" is not null;