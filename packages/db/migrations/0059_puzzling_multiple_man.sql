CREATE TYPE "public"."campaign_channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipient_state" AS ENUM('pending', 'queued', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."campaign_state" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address" text NOT NULL,
	"state" "campaign_recipient_state" DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"message_id" uuid,
	"queued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel" "campaign_channel" NOT NULL,
	"state" "campaign_state" DEFAULT 'draft' NOT NULL,
	"audience" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"utm_campaign" text NOT NULL,
	"messaging_campaign_id" uuid,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unsubscribe_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"address" text NOT NULL,
	"campaign_id" uuid,
	"used_at" timestamp with time zone,
	"used_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_campaign_id_marketing_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaign"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_campaign" ADD CONSTRAINT "marketing_campaign_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unsubscribe_link" ADD CONSTRAINT "unsubscribe_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unsubscribe_link" ADD CONSTRAINT "unsubscribe_link_campaign_id_marketing_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipient_once_idx" ON "campaign_recipient" USING btree ("campaign_id","address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipient_state_idx" ON "campaign_recipient" USING btree ("campaign_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipient_customer_idx" ON "campaign_recipient" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_campaign_state_idx" ON "marketing_campaign" USING btree ("organization_id","state","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_campaign_utm_idx" ON "marketing_campaign" USING btree ("organization_id","utm_campaign") WHERE "marketing_campaign"."deleted_at" is null and "marketing_campaign"."cancelled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unsubscribe_link_token_idx" ON "unsubscribe_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unsubscribe_link_address_idx" ON "unsubscribe_link" USING btree ("organization_id","address");