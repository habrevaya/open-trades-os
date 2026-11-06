ALTER TABLE "tip_split_override" DROP CONSTRAINT "tip_split_override_subject";--> statement-breakpoint
DROP INDEX IF EXISTS "tip_split_override_technician_idx";--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD COLUMN "job_type_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD COLUMN "crew_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD COLUMN "starts_on" date;--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_vehicle_from" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_checked_out_label" text;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "run_rate_recent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "line_blends" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tip_split_override_job_type_idx" ON "tip_split_override" USING btree ("organization_id","job_type_id") WHERE "tip_split_override"."job_type_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tip_split_override_crew_idx" ON "tip_split_override" USING btree ("organization_id","crew_id") WHERE "tip_split_override"."crew_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tip_split_override_technician_idx" ON "tip_split_override" USING btree ("organization_id","technician_id",coalesce("starts_on", '-infinity'::date)) WHERE "tip_split_override"."technician_id" is not null;--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_dates" CHECK (("tip_split_override"."starts_on" is null and "tip_split_override"."ends_on" is null) or "tip_split_override"."technician_id" is not null);--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_date_order" CHECK ("tip_split_override"."starts_on" is null or "tip_split_override"."ends_on" is null or "tip_split_override"."starts_on" <= "tip_split_override"."ends_on");--> statement-breakpoint
ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_subject" CHECK ((
    ("tip_split_override"."job_id" is not null)::int + ("tip_split_override"."job_type_id" is not null)::int
    + ("tip_split_override"."crew_id" is not null)::int + ("tip_split_override"."technician_id" is not null)::int
  ) = 1);