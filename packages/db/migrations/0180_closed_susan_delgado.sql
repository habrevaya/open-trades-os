CREATE TABLE IF NOT EXISTS "business_hours_season" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"repeats_yearly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_hours_season_in_order" CHECK ("business_hours_season"."ends_on" >= "business_hours_season"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "business_hours" ADD COLUMN "season_id" uuid;--> statement-breakpoint
ALTER TABLE "crew" ADD COLUMN "weekday_hours" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_hours_season" ADD CONSTRAINT "business_hours_season_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_hours_season" ADD CONSTRAINT "business_hours_season_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_hours_season_org_idx" ON "business_hours_season" USING btree ("organization_id","business_unit_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_season_id_business_hours_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."business_hours_season"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_hours_season_idx" ON "business_hours" USING btree ("season_id");--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_season_not_number" CHECK ("business_hours"."season_id" is null or "business_hours"."phone_number_id" is null);