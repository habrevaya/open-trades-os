ALTER TYPE "public"."staff_delivery_channel" ADD VALUE 'email';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "certification_renewals_keeper" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "person_certification" ADD COLUMN "renewal_lead_days" integer;--> statement-breakpoint
ALTER TABLE "staff_notice_setting" ADD COLUMN "email" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "certification_renewals_keeper" ADD CONSTRAINT "certification_renewals_keeper_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "certification_renewals_keeper" ADD CONSTRAINT "certification_renewals_keeper_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "certification_renewals_keeper_person_idx" ON "certification_renewals_keeper" USING btree ("organization_id","user_id");--> statement-breakpoint
-- The one person who kept the renewals list is kept, as the first of the people who now can. The old
-- column is no longer read, so it is emptied rather than left to say something different.
INSERT INTO "certification_renewals_keeper" ("organization_id", "user_id")
SELECT "id", "renewals_keeper_user_id" FROM "organization" WHERE "renewals_keeper_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "organization" SET "renewals_keeper_user_id" = NULL WHERE "renewals_keeper_user_id" IS NOT NULL;

--> statement-breakpoint
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
--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('stars', 'recommendation');--> statement-breakpoint
ALTER TABLE "review" ALTER COLUMN "rating" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "kind" "review_kind" DEFAULT 'stars' NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "recommends" boolean;--> statement-breakpoint
-- A Facebook recommendation that was read as five or one stars is a recommendation again. Only where the
-- source says so: read from a Facebook Page connection, with no words of the person's own, so the review says
-- what Facebook's yes or no was turned into. One with words in it cannot be told from an old star rating here;
-- the next hourly read of the Page converts it, since Facebook says which it is.
UPDATE "review" r SET "kind" = 'recommendation', "recommends" = (r."body" = 'Recommends you on Facebook.'), "rating" = NULL
 WHERE r."connection_id" IN (SELECT c."id" FROM "integration_connection" c WHERE c."provider" = 'facebook_page')
   AND r."body" IN ('Recommends you on Facebook.', 'Does not recommend you on Facebook.');--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_kind_fields" CHECK ((
    "review"."kind" = 'stars' and "review"."rating" is not null and "review"."rating" between 1 and 5 and "review"."recommends" is null
  ) or (
    "review"."kind" = 'recommendation' and "review"."rating" is null and "review"."recommends" is not null
  ));
