ALTER TABLE "expense" DROP CONSTRAINT "expense_rate_source_known";--> statement-breakpoint
ALTER TABLE "mileage_rate_override" DROP CONSTRAINT "mileage_rate_override_one_subject";--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_job_type_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_job_type_label" text;--> statement-breakpoint
ALTER TABLE "mileage_rate_override" ADD COLUMN "job_type_id" uuid;--> statement-breakpoint
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
ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_one_subject" CHECK ((("mileage_rate_override"."technician_id" is not null)::int + ("mileage_rate_override"."asset_id" is not null)::int + ("mileage_rate_override"."job_type_id" is not null)::int) = 1);