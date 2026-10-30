ALTER TABLE "price_book_item_version" ADD COLUMN "picture_key" text;--> statement-breakpoint
ALTER TABLE "review_policy" ADD COLUMN "second_reminder_after_days" integer;--> statement-breakpoint
ALTER TABLE "review_policy" ADD COLUMN "follow_up_after_days" integer;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "follow_up_message_id" uuid;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "follow_up_detail" text;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "second_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "second_reminder_message_id" uuid;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "second_reminder_detail" text;