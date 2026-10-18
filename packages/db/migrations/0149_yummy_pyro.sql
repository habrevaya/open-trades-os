CREATE TYPE "public"."standing_share_applies" AS ENUM('always', 'as_lead');--> statement-breakpoint
ALTER TYPE "public"."campaign_recipient_state" ADD VALUE 'held';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_standing_share" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"percent" integer NOT NULL,
	"applies" "standing_share_applies" NOT NULL,
	"reason" text NOT NULL,
	"set_by_user_id" uuid,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "commission_event" ADD COLUMN "standing_note" text;--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD COLUMN "held_back" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "hold_back_share" integer;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_variant" "campaign_variant";--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_was_winner" boolean;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "rest_started_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_standing_share" ADD CONSTRAINT "commission_standing_share_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_standing_share" ADD CONSTRAINT "commission_standing_share_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_standing_share_live_idx" ON "commission_standing_share" USING btree ("organization_id","technician_id") WHERE "commission_standing_share"."ended_at" is null;