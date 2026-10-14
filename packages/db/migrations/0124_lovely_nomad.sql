CREATE TYPE "public"."phone_hours_from" AS ENUM('branch', 'company', 'own');--> statement-breakpoint
ALTER TABLE "business_hours" ADD COLUMN "phone_number_id" uuid;--> statement-breakpoint
ALTER TABLE "company_holiday" ADD COLUMN "phone_number_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "hours_from" "phone_hours_from" DEFAULT 'branch' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_holiday_number_idx" ON "company_holiday" USING btree ("phone_number_id");--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_one_owner" CHECK ("business_hours"."business_unit_id" is null or "business_hours"."phone_number_id" is null);--> statement-breakpoint
ALTER TABLE "company_holiday" ADD CONSTRAINT "company_holiday_one_owner" CHECK ("company_holiday"."business_unit_id" is null or "company_holiday"."phone_number_id" is null);--> statement-breakpoint
-- Written by hand: the schema cannot name phone_number from scheduling.ts without an import cycle (see the column's comment).
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_holiday" ADD CONSTRAINT "company_holiday_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE cascade ON UPDATE no action;
