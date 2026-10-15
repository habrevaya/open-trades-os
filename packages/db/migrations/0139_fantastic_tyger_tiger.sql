ALTER TABLE "ai_chat_session" ADD COLUMN "customer_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_chat_session" ADD COLUMN "customer_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_chat_session" ADD COLUMN "customer_notice" text;