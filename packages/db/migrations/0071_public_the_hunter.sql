CREATE TYPE "public"."referral_reward_state" AS ENUM('credited', 'owed', 'paid', 'void');--> statement-breakpoint
ALTER TYPE "public"."phone_number_purpose" ADD VALUE 'pool';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_reward" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"referrer_customer_id" uuid NOT NULL,
	"referred_customer_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"state" "referral_reward_state" NOT NULL,
	"credit_note_id" uuid,
	"paid_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dni_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visitor_id" text NOT NULL,
	"phone_number_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"landing_query" text,
	"referrer" text,
	"landing_path" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public_rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "public_rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "referred_by_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "recording_storage_key" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "voicemail_storage_key" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "routed_because" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "provider_number_id" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "whisper" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "record_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "route_by_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "after_hours_forwards_to_e164" text;--> statement-breakpoint
ALTER TABLE "marketing_touch" ADD COLUMN "referrer_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "web_form" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "web_form" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_reward" ADD CONSTRAINT "referral_reward_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_reward" ADD CONSTRAINT "referral_reward_referrer_customer_id_customer_id_fk" FOREIGN KEY ("referrer_customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_reward" ADD CONSTRAINT "referral_reward_referred_customer_id_customer_id_fk" FOREIGN KEY ("referred_customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_reward" ADD CONSTRAINT "referral_reward_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dni_session" ADD CONSTRAINT "dni_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dni_session" ADD CONSTRAINT "dni_session_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_reward_referred_idx" ON "referral_reward" USING btree ("organization_id","referred_customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_reward_referrer_idx" ON "referral_reward" USING btree ("organization_id","referrer_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dni_session_live_idx" ON "dni_session" USING btree ("organization_id","phone_number_id") WHERE "dni_session"."released_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dni_session_visitor_idx" ON "dni_session" USING btree ("organization_id","visitor_id","last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dni_session_number_idx" ON "dni_session" USING btree ("organization_id","phone_number_id","assigned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_rate_limit_window_idx" ON "public_rate_limit" USING btree ("window_start");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer" ADD CONSTRAINT "customer_referred_by_customer_id_customer_id_fk" FOREIGN KEY ("referred_by_customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketing_touch" ADD CONSTRAINT "marketing_touch_referrer_customer_id_customer_id_fk" FOREIGN KEY ("referrer_customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_referral_code_idx" ON "customer" USING btree ("organization_id","referral_code") WHERE "customer"."referral_code" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_referred_by_idx" ON "customer" USING btree ("organization_id","referred_by_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_form_public_key_idx" ON "web_form" USING btree ("public_key") WHERE "web_form"."public_key" is not null;