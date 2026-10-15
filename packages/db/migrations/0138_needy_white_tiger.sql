ALTER TABLE "job" ADD COLUMN "budgeted_hours" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "crew_hours" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "job_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order" ADD CONSTRAINT "project_change_order_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
