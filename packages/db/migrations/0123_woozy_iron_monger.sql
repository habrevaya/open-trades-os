CREATE TYPE "public"."holiday_observed" AS ENUM('as_is', 'sunday_to_monday', 'weekend_to_weekday');--> statement-breakpoint
ALTER TABLE "company_holiday" ADD COLUMN "rule" jsonb;--> statement-breakpoint
ALTER TABLE "company_holiday" ADD COLUMN "observed" "holiday_observed" DEFAULT 'as_is' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_holiday" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "truck_kind" ADD COLUMN "capacity_by_size" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_holiday" ADD CONSTRAINT "company_holiday_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_holiday_branch_idx" ON "company_holiday" USING btree ("business_unit_id");