ALTER TABLE "review_policy" ADD COLUMN "reminder_after_days" integer;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "reminder_message_id" uuid;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "reminder_detail" text;