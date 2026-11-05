CREATE TYPE "public"."phone_menu_hours_from" AS ENUM('number', 'branch', 'company', 'own');--> statement-breakpoint
ALTER TABLE "business_hours" ADD COLUMN "phone_menu_id" uuid;--> statement-breakpoint
ALTER TABLE "company_holiday" ADD COLUMN "phone_menu_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_menu" ADD COLUMN "hours_from" "phone_menu_hours_from" DEFAULT 'number' NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_menu" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_menu" ADD CONSTRAINT "phone_menu_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_holiday_menu_idx" ON "company_holiday" USING btree ("phone_menu_id");--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_menu_owner" CHECK ("business_hours"."phone_menu_id" is null or ("business_hours"."business_unit_id" is null and "business_hours"."phone_number_id" is null and "business_hours"."season_id" is null));--> statement-breakpoint
ALTER TABLE "company_holiday" ADD CONSTRAINT "company_holiday_menu_owner" CHECK ("company_holiday"."phone_menu_id" is null or ("company_holiday"."business_unit_id" is null and "company_holiday"."phone_number_id" is null));