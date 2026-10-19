CREATE TYPE "public"."safety_talk_audience" AS ENUM('crew', 'person', 'role', 'branch', 'company');--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" DROP CONSTRAINT "safety_talk_schedule_who";--> statement-breakpoint
-- A schedule written before there were audiences was for one crew or one person, whichever column it named.
ALTER TABLE "safety_talk_schedule" ADD COLUMN "audience" "safety_talk_audience";--> statement-breakpoint
UPDATE "safety_talk_schedule" SET "audience" = CASE WHEN "crew_id" IS NOT NULL THEN 'crew'::"safety_talk_audience" ELSE 'person'::"safety_talk_audience" END;--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" ALTER COLUMN "audience" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" ADD COLUMN "audience_role" "member_role";--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" ADD COLUMN "audience_role_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" ADD COLUMN "audience_business_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" ADD COLUMN "skip_holidays" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_audience_role_id_role_id_fk" FOREIGN KEY ("audience_role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_audience_business_unit_id_business_unit_id_fk" FOREIGN KEY ("audience_business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_audience" CHECK ((
    "safety_talk_schedule"."audience" = 'crew' and "safety_talk_schedule"."crew_id" is not null and "safety_talk_schedule"."technician_id" is null
      and "safety_talk_schedule"."audience_role" is null and "safety_talk_schedule"."audience_role_id" is null and "safety_talk_schedule"."audience_business_unit_id" is null
  ) or (
    "safety_talk_schedule"."audience" = 'person' and "safety_talk_schedule"."technician_id" is not null and "safety_talk_schedule"."crew_id" is null
      and "safety_talk_schedule"."audience_role" is null and "safety_talk_schedule"."audience_role_id" is null and "safety_talk_schedule"."audience_business_unit_id" is null
  ) or (
    "safety_talk_schedule"."audience" = 'role' and "safety_talk_schedule"."crew_id" is null and "safety_talk_schedule"."technician_id" is null and "safety_talk_schedule"."audience_business_unit_id" is null
      and (("safety_talk_schedule"."audience_role" is not null) <> ("safety_talk_schedule"."audience_role_id" is not null))
  ) or (
    "safety_talk_schedule"."audience" = 'branch' and "safety_talk_schedule"."audience_business_unit_id" is not null and "safety_talk_schedule"."crew_id" is null and "safety_talk_schedule"."technician_id" is null
      and "safety_talk_schedule"."audience_role" is null and "safety_talk_schedule"."audience_role_id" is null
  ) or (
    "safety_talk_schedule"."audience" = 'company' and "safety_talk_schedule"."crew_id" is null and "safety_talk_schedule"."technician_id" is null
      and "safety_talk_schedule"."audience_role" is null and "safety_talk_schedule"."audience_role_id" is null and "safety_talk_schedule"."audience_business_unit_id" is null
  ));