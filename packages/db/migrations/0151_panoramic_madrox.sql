ALTER TABLE "job_hold" ADD COLUMN "nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_hold" ADD COLUMN "nudge_task_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold" ADD CONSTRAINT "job_hold_nudge_task_id_task_id_fk" FOREIGN KEY ("nudge_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
