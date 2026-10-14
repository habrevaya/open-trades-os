ALTER TABLE "call" ADD COLUMN "callee_leg_sid" text;--> statement-breakpoint
ALTER TABLE "phone_menu" ADD COLUMN "speech" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_chat_session" ADD COLUMN "writing" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_callee_leg_idx" ON "call" USING btree ("callee_leg_sid") WHERE "call"."callee_leg_sid" is not null;