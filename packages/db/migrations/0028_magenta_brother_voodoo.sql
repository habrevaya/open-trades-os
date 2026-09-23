CREATE TYPE "public"."form_submission_state" AS ENUM('received', 'accepted', 'rejected', 'spam');--> statement-breakpoint
CREATE TYPE "public"."touch_basis" AS ENUM('utm', 'click_id', 'tracked_number', 'referrer', 'none');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"campaign" text,
	"spent_on" date NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"origin" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"state" "form_submission_state" DEFAULT 'received' NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"clean" jsonb,
	"refusals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"touch_id" uuid,
	"customer_id" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_touch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visitor_id" text,
	"customer_id" uuid,
	"job_id" uuid,
	"source" text NOT NULL,
	"basis" "touch_basis" NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"click_id" text,
	"referrer_host" text,
	"landing_path" text,
	"tracked_number_e164" text,
	"unrecognised" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "web_form" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"definition" jsonb NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_form_id_web_form_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."web_form"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_touch_id_marketing_touch_id_fk" FOREIGN KEY ("touch_id") REFERENCES "public"."marketing_touch"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_form" ADD CONSTRAINT "web_form_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_spend_uniq_idx" ON "ad_spend" USING btree ("organization_id","source","campaign","spent_on","origin") WHERE "ad_spend"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_spend_date_idx" ON "ad_spend" USING btree ("organization_id","spent_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submission_form_idx" ON "form_submission" USING btree ("organization_id","form_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submission_state_idx" ON "form_submission" USING btree ("organization_id","state","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_touch_visitor_idx" ON "marketing_touch" USING btree ("organization_id","visitor_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_touch_customer_idx" ON "marketing_touch" USING btree ("organization_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_touch_unrecognised_idx" ON "marketing_touch" USING btree ("organization_id","occurred_at") WHERE "marketing_touch"."unrecognised" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_touch_source_idx" ON "marketing_touch" USING btree ("organization_id","source","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_form_slug_idx" ON "web_form" USING btree ("organization_id","slug") WHERE "web_form"."deleted_at" is null;