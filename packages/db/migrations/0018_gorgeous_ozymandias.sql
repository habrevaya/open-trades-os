ALTER TYPE "public"."workflow_run_status" ADD VALUE 'waiting' BEFORE 'succeeded';--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "resume_step_index" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_resume_idx" ON "workflow_run" USING btree ("resume_at") WHERE "workflow_run"."resume_at" is not null;