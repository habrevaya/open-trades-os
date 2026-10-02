CREATE TYPE "public"."acquisition_cost_model" AS ENUM('recorded', 'fixed', 'per_lead');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acquisition_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"cost_model" "acquisition_cost_model" DEFAULT 'recorded' NOT NULL,
	"cost_amount" numeric(14, 4),
	"budget" numeric(14, 4),
	"utm_campaign" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_key" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "lead_source_origin" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "lead_source_origin" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "lead_source_connector" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "first_time_caller" boolean;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "acquisition_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "call_id" uuid;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "caller_e164" text;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "entered_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acquisition_campaign" ADD CONSTRAINT "acquisition_campaign_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acquisition_campaign" ADD CONSTRAINT "acquisition_campaign_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_channel" ADD CONSTRAINT "marketing_channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acquisition_campaign_channel_idx" ON "acquisition_campaign" USING btree ("organization_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acquisition_campaign_name_idx" ON "acquisition_campaign" USING btree ("organization_id",lower("name")) WHERE "acquisition_campaign"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acquisition_campaign_utm_idx" ON "acquisition_campaign" USING btree ("organization_id",lower("utm_campaign")) WHERE "acquisition_campaign"."archived_at" is null and "acquisition_campaign"."utm_campaign" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_channel_name_idx" ON "marketing_channel" USING btree ("organization_id",lower("name")) WHERE "marketing_channel"."archived_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_channel_source_idx" ON "marketing_channel" USING btree ("organization_id","source_key");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer" ADD CONSTRAINT "customer_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer" ADD CONSTRAINT "customer_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_source_connector" ADD CONSTRAINT "lead_source_connector_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_channel_id_marketing_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."marketing_channel"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_acquisition_campaign_id_acquisition_campaign_id_fk" FOREIGN KEY ("acquisition_campaign_id") REFERENCES "public"."acquisition_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_touch_caller_idx" ON "marketing_touch" USING btree ("organization_id","caller_e164") WHERE "marketing_touch"."caller_e164" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_touch_job_idx" ON "marketing_touch" USING btree ("organization_id","job_id");--> statement-breakpoint
ALTER TABLE "phone_number" RENAME COLUMN "campaign_id" TO "messaging_campaign_id";--> statement-breakpoint
ALTER TABLE "phone_number" RENAME CONSTRAINT "phone_number_campaign_id_messaging_campaign_id_fk" TO "phone_number_messaging_campaign_id_messaging_campaign_id_fk";
