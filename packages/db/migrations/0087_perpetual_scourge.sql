CREATE TYPE "public"."mail_campaign_state" AS ENUM('draft', 'sending', 'sent', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mail_piece_state" AS ENUM('pending', 'sent', 'skipped', 'refused', 'failed');--> statement-breakpoint
ALTER TYPE "public"."capability" ADD VALUE 'direct_mail';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text,
	"platform" text,
	"outcome" text NOT NULL,
	"reason" text,
	"offer_id" uuid,
	"excerpt" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token" text NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_offer_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"external_id" text,
	"state" text NOT NULL,
	"error" text,
	"sent_by_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_conversion_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"send_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"previous_value" numeric(14, 4) NOT NULL,
	"new_value" numeric(14, 4) NOT NULL,
	"sent_value" numeric(14, 4),
	"currency" char(3),
	"state" "ad_send_state" NOT NULL,
	"event_id" text NOT NULL,
	"detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analytics_session_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"day" date NOT NULL,
	"session_source" text NOT NULL,
	"session_medium" text NOT NULL,
	"source" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"engaged_sessions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_query_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"day" date NOT NULL,
	"query" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position" numeric(7, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"size" text,
	"audience" jsonb NOT NULL,
	"acquisition_campaign_id" uuid NOT NULL,
	"front" text NOT NULL,
	"back" text,
	"landing_headline" text,
	"landing_body" text,
	"price_per_piece" numeric(14, 4),
	"state" "mail_campaign_state" DEFAULT 'draft' NOT NULL,
	"sent_on" date,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_piece" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mail_campaign_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"name" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"code" text NOT NULL,
	"status" "mail_piece_state" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"provider_id" text,
	"expected_delivery_on" date,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"first_visited_at" timestamp with time zone,
	"visits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lead_offer" ADD COLUMN "charge" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "lead_offer" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_source_connector" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "lead_source_connector" ADD COLUMN "kind" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_email" ADD CONSTRAINT "lead_email_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_email" ADD CONSTRAINT "lead_email_offer_id_lead_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."lead_offer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_inbox" ADD CONSTRAINT "lead_inbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer_message" ADD CONSTRAINT "lead_offer_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer_message" ADD CONSTRAINT "lead_offer_message_offer_id_lead_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."lead_offer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer_message" ADD CONSTRAINT "lead_offer_message_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_adjustment" ADD CONSTRAINT "ad_conversion_adjustment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_adjustment" ADD CONSTRAINT "ad_conversion_adjustment_send_id_ad_conversion_send_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."ad_conversion_send"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_conversion_adjustment" ADD CONSTRAINT "ad_conversion_adjustment_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analytics_session_day" ADD CONSTRAINT "analytics_session_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analytics_session_day" ADD CONSTRAINT "analytics_session_day_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_query_day" ADD CONSTRAINT "search_query_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_query_day" ADD CONSTRAINT "search_query_day_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_mail_campaign_id_mail_campaign_id_fk" FOREIGN KEY ("mail_campaign_id") REFERENCES "public"."mail_campaign"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_email_provider_idx" ON "lead_email" USING btree ("organization_id","provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_email_recent_idx" ON "lead_email" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_inbox_org_idx" ON "lead_inbox" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_inbox_token_idx" ON "lead_inbox" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_offer_message_thread_idx" ON "lead_offer_message" USING btree ("offer_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_offer_message_external_idx" ON "lead_offer_message" USING btree ("offer_id","external_id") WHERE "lead_offer_message"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_conversion_adjustment_sequence_idx" ON "ad_conversion_adjustment" USING btree ("send_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_conversion_adjustment_queue_idx" ON "ad_conversion_adjustment" USING btree ("organization_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_session_day_idx" ON "analytics_session_day" USING btree ("connection_id","day","session_source","session_medium");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_session_day_org_idx" ON "analytics_session_day" USING btree ("organization_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_query_day_idx" ON "search_query_day" USING btree ("connection_id","day","query");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_query_day_org_idx" ON "search_query_day" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_campaign_org_idx" ON "mail_campaign" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_piece_recipient_idx" ON "mail_piece" USING btree ("mail_campaign_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_piece_code_idx" ON "mail_piece" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_piece_pending_idx" ON "mail_piece" USING btree ("mail_campaign_id","status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_source_connector" ADD CONSTRAINT "lead_source_connector_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
