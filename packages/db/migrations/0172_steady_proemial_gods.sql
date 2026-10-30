CREATE TABLE IF NOT EXISTS "job_hold_nudge_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" "job_hold_reason",
	"business_unit_id" uuid,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_hold_nudge_rule_reaches" CHECK ("job_hold_nudge_rule"."reason" is not null or "job_hold_nudge_rule"."business_unit_id" is not null)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold_nudge_rule" ADD CONSTRAINT "job_hold_nudge_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold_nudge_rule" ADD CONSTRAINT "job_hold_nudge_rule_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold_nudge_rule" ADD CONSTRAINT "job_hold_nudge_rule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_hold_nudge_rule_org_idx" ON "job_hold_nudge_rule" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_hold_nudge_rule_both_idx" ON "job_hold_nudge_rule" USING btree ("organization_id","reason","business_unit_id") WHERE "job_hold_nudge_rule"."reason" is not null and "job_hold_nudge_rule"."business_unit_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_hold_nudge_rule_reason_idx" ON "job_hold_nudge_rule" USING btree ("organization_id","reason") WHERE "job_hold_nudge_rule"."reason" is not null and "job_hold_nudge_rule"."business_unit_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_hold_nudge_rule_branch_idx" ON "job_hold_nudge_rule" USING btree ("organization_id","business_unit_id") WHERE "job_hold_nudge_rule"."reason" is null and "job_hold_nudge_rule"."business_unit_id" is not null;