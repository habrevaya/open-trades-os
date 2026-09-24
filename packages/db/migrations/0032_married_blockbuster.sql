CREATE TYPE "public"."review_request_state" AS ENUM('queued', 'sent', 'converted', 'withheld', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text,
	"rating" integer NOT NULL,
	"author_name" text,
	"body" text,
	"posted_at" timestamp with time zone NOT NULL,
	"job_id" uuid,
	"customer_id" uuid,
	"technician_id" uuid,
	"responded_at" timestamp with time zone,
	"response_body" text,
	"responded_by_user_id" uuid,
	"recovery_due_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_platform" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"display_name" text NOT NULL,
	"review_url" text,
	"prohibits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"time_zone" text NOT NULL,
	"delay_minutes" integer DEFAULT 120 NOT NULL,
	"customer_cooldown_days" integer DEFAULT 90 NOT NULL,
	"require_paid" boolean DEFAULT true NOT NULL,
	"max_job_age_days" integer DEFAULT 14 NOT NULL,
	"earliest_hour" integer DEFAULT 9 NOT NULL,
	"latest_hour" integer DEFAULT 19 NOT NULL,
	"recover_at_or_below" integer DEFAULT 3 NOT NULL,
	"same_day_at_or_below" integer DEFAULT 2 NOT NULL,
	"business_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"open_hour" integer DEFAULT 8 NOT NULL,
	"close_hour" integer DEFAULT 17 NOT NULL,
	"bands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"half_life_days" integer DEFAULT 365 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"platform" text,
	"state" "review_request_state" DEFAULT 'queued' NOT NULL,
	"send_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"message_id" uuid,
	"withheld_reason" text,
	"withheld_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review" ADD CONSTRAINT "review_responded_by_user_id_user_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_platform" ADD CONSTRAINT "review_platform_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_policy" ADD CONSTRAINT "review_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_request" ADD CONSTRAINT "review_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_request" ADD CONSTRAINT "review_request_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_request" ADD CONSTRAINT "review_request_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_external_idx" ON "review" USING btree ("organization_id","platform","external_id") WHERE "review"."external_id" is not null and "review"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_open_idx" ON "review" USING btree ("organization_id","responded_at","posted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_technician_idx" ON "review" USING btree ("organization_id","technician_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_platform_idx" ON "review_platform" USING btree ("organization_id","platform") WHERE "review_platform"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_policy_active_idx" ON "review_policy" USING btree ("organization_id") WHERE "review_policy"."active" and "review_policy"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_request_job_idx" ON "review_request" USING btree ("job_id") WHERE "review_request"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_request_customer_idx" ON "review_request" USING btree ("organization_id","customer_id","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_request_queue_idx" ON "review_request" USING btree ("organization_id","state","send_at");