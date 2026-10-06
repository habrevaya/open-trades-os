CREATE TABLE IF NOT EXISTS "agreement_term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"term" integer NOT NULL,
	"starts_on" date,
	"ends_on" date NOT NULL,
	"breakage_released_on" date,
	"breakage_amount" numeric(14, 4),
	"breakage_visits" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "discount_exclusions" jsonb DEFAULT '{"categoryIds":[],"itemIds":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_plan" ADD COLUMN "discount_exclusions" jsonb DEFAULT '{"categoryIds":[],"itemIds":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_plan" ADD COLUMN "member_hold_percent" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_term" ADD CONSTRAINT "agreement_term_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agreement_term" ADD CONSTRAINT "agreement_term_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_term_idx" ON "agreement_term" USING btree ("agreement_id","term");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreement_term_due_idx" ON "agreement_term" USING btree ("organization_id","ends_on");