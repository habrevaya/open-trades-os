ALTER TABLE "portal_layout" ADD COLUMN "agreement_plan_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_layout" ADD CONSTRAINT "portal_layout_agreement_plan_id_agreement_plan_id_fk" FOREIGN KEY ("agreement_plan_id") REFERENCES "public"."agreement_plan"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_layout_plan_idx" ON "portal_layout" USING btree ("organization_id","agreement_plan_id") WHERE "portal_layout"."agreement_plan_id" is not null;