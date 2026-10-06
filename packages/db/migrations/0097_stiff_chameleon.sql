ALTER TYPE "public"."visit_change_status" ADD VALUE 'proposed';--> statement-breakpoint
ALTER TYPE "public"."visit_change_status" ADD VALUE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."visit_change_status" ADD VALUE 'turned_down';--> statement-breakpoint
DROP INDEX IF EXISTS "visit_change_request_pending_idx";--> statement-breakpoint
ALTER TABLE "visit_change_request" ADD COLUMN "proposed_date" date;--> statement-breakpoint
ALTER TABLE "visit_change_request" ADD COLUMN "proposed_arrival_window_id" uuid;--> statement-breakpoint
ALTER TABLE "visit_change_request" ADD COLUMN "proposed_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_change_request" ADD COLUMN "proposed_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_change_request" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_change_request" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "push_delivery" ADD COLUMN "office_told_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_proposed_arrival_window_id_arrival_window_id_fk" FOREIGN KEY ("proposed_arrival_window_id") REFERENCES "public"."arrival_window"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The open request index is rebuilt by sql/after.sql: it names 'proposed',
-- which Postgres will not use in the transaction that added it.
-- Notices that ended before the office was told about missed ones are history, not news.
UPDATE "push_delivery" SET "office_told_at" = "updated_at" WHERE "status" IN ('failed', 'skipped');
