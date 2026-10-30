ALTER TABLE "estimate" ADD COLUMN "follow_up_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_hold" ADD COLUMN "nudge_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_chat_session" ADD COLUMN "office_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_chat_session" ADD COLUMN "office_closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_chat_session" ADD COLUMN "office_close_kind" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_chat_session" ADD CONSTRAINT "ai_chat_session_office_closed_by_user_id_user_id_fk" FOREIGN KEY ("office_closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
