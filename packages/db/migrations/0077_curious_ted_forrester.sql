CREATE TYPE "public"."ad_event_kind" AS ENUM('lead', 'purchase');--> statement-breakpoint
CREATE TYPE "public"."ad_send_state" AS ENUM('sending', 'sent', 'withheld', 'refused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."advertising_choice" AS ENUM('granted', 'refused');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_conversion_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"kind" "ad_event_kind" NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid,
	"state" "ad_send_state" NOT NULL,
	"event_id" text NOT NULL,
	"value" numeric(14, 4),
	"currency" char(3),
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"click_id" text,
	"ad_user_data" text,
	"withheld_reason" text,
	"detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_platform_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_type" text,
	"source" text NOT NULL,
	"acquisition_campaign_id" uuid,
	"mapped_by" text,
	"last_spent_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "advertising_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"choice" "advertising_choice" NOT NULL,
	"method" "consent_method" NOT NULL,
	"proof_text" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_by_user_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sealed_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"sealed" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"granted_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "click_id_param" text;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "ga_client_id" text;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "meta_browser_id" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "reply_state" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "reply_error" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "reply_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "suggested_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "suggested_job_id" uuid;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "suggestion_reason" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "suggestion_dismissed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_send" ADD CONSTRAINT "ad_conversion_send_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_send" ADD CONSTRAINT "ad_conversion_send_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_send" ADD CONSTRAINT "ad_conversion_send_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_send" ADD CONSTRAINT "ad_conversion_send_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_platform_campaign" ADD CONSTRAINT "ad_platform_campaign_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_platform_campaign" ADD CONSTRAINT "ad_platform_campaign_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_platform_campaign" ADD CONSTRAINT "ad_platform_campaign_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advertising_consent" ADD CONSTRAINT "advertising_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advertising_consent" ADD CONSTRAINT "advertising_consent_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "advertising_consent" ADD CONSTRAINT "advertising_consent_captured_by_user_id_user_id_fk" FOREIGN KEY ("captured_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization" ADD CONSTRAINT "oauth_authorization_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization" ADD CONSTRAINT "oauth_authorization_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization" ADD CONSTRAINT "oauth_authorization_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sealed_credential" ADD CONSTRAINT "sealed_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sealed_credential" ADD CONSTRAINT "sealed_credential_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sealed_credential" ADD CONSTRAINT "sealed_credential_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_conversion_send_idx" ON "ad_conversion_send" USING btree ("organization_id","provider","kind","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_conversion_send_queue_idx" ON "ad_conversion_send" USING btree ("organization_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_platform_campaign_idx" ON "ad_platform_campaign" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_platform_campaign_mapped_idx" ON "ad_platform_campaign" USING btree ("organization_id","acquisition_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "advertising_consent_live_idx" ON "advertising_consent" USING btree ("customer_id") WHERE "advertising_consent"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "advertising_consent_customer_idx" ON "advertising_consent" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_authorization_state_idx" ON "oauth_authorization" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sealed_credential_connection_idx" ON "sealed_credential" USING btree ("connection_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_suggested_customer_id_customer_id_fk" FOREIGN KEY ("suggested_customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_suggested_job_id_job_id_fk" FOREIGN KEY ("suggested_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
