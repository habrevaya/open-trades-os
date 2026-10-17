ALTER TYPE "public"."campaign_recipient_state" ADD VALUE 'held';--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD COLUMN "held_back" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "hold_back_share" integer;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_variant" "campaign_variant";--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_was_winner" boolean;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_started_by_user_id" uuid;