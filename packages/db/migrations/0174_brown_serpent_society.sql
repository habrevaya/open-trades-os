CREATE TABLE IF NOT EXISTS "office_on_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_rate_source_known";--> statement-breakpoint
ALTER TABLE "mileage_rate_override" DROP CONSTRAINT "mileage_rate_override_one_subject";--> statement-breakpoint
ALTER TABLE "crew" ADD COLUMN "workday" jsonb;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_job_type_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_job_type_label" text;--> statement-breakpoint
ALTER TABLE "mileage_rate_override" ADD COLUMN "job_type_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_notice_digest" ADD COLUMN "hour" integer;--> statement-breakpoint
ALTER TABLE "staff_notice_setting" ADD COLUMN "chosen" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "office_on_call" ADD CONSTRAINT "office_on_call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "office_on_call" ADD CONSTRAINT "office_on_call_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "office_on_call_turn_idx" ON "office_on_call" USING btree ("organization_id","user_id","starts_on","ends_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_on_call_day_idx" ON "office_on_call" USING btree ("organization_id","ends_on","starts_on");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense" ADD CONSTRAINT "expense_mileage_job_type_id_job_type_id_fk" FOREIGN KEY ("mileage_job_type_id") REFERENCES "public"."job_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mileage_rate_override_work_day_idx" ON "mileage_rate_override" USING btree ("organization_id","job_type_id","from_day") WHERE job_type_id is not null;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_rate_source_known" CHECK ("expense"."mileage_rate_source" is null or "expense"."mileage_rate_source" in ('company', 'person', 'vehicle', 'work'));--> statement-breakpoint
ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_one_subject" CHECK ((("mileage_rate_override"."technician_id" is not null)::int + ("mileage_rate_override"."asset_id" is not null)::int + ("mileage_rate_override"."job_type_id" is not null)::int) = 1);--> statement-breakpoint
-- Data backfill, written by hand: a row the company's defaults copied onto a
-- person when they joined was inserted by the membership trigger in the same
-- transaction as the membership (so the same created_at) and has not been
-- saved since (updated_at still equals created_at). Those are the company's,
-- not the person's own choice. Every other row stays a choice of the person's.
UPDATE "staff_notice_setting" s SET "chosen" = false
 WHERE s."updated_at" = s."created_at"
   AND EXISTS (
     SELECT 1 FROM "membership" m
      WHERE m."organization_id" = s."organization_id"
        AND m."user_id" = s."user_id"
        AND m."created_at" = s."created_at"
   );
