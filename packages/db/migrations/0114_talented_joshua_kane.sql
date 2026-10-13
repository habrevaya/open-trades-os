CREATE TYPE "public"."staff_delivery_channel" AS ENUM('push', 'sms');--> statement-breakpoint
CREATE TYPE "public"."staff_delivery_status" AS ENUM('queued', 'held', 'sending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."staff_text_consent_state" AS ENUM('granted', 'revoked');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"href" text NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_notice_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"channel" "staff_delivery_channel" NOT NULL,
	"device_id" uuid,
	"address" text,
	"target" text NOT NULL,
	"status" "staff_delivery_status" DEFAULT 'queued' NOT NULL,
	"quiet" boolean DEFAULT false NOT NULL,
	"hold_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ticket_id" text,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"receipt_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_notice_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"in_app" boolean NOT NULL,
	"push" boolean NOT NULL,
	"text" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_text_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"state" "staff_text_consent_state" NOT NULL,
	"proof_text" text,
	"ip_address" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice_delivery" ADD CONSTRAINT "staff_notice_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice_delivery" ADD CONSTRAINT "staff_notice_delivery_notice_id_staff_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."staff_notice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice_delivery" ADD CONSTRAINT "staff_notice_delivery_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice_setting" ADD CONSTRAINT "staff_notice_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_notice_setting" ADD CONSTRAINT "staff_notice_setting_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_text_consent" ADD CONSTRAINT "staff_text_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_text_consent" ADD CONSTRAINT "staff_text_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_notice_source_idx" ON "staff_notice" USING btree ("organization_id","user_id","source_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_notice_person_idx" ON "staff_notice" USING btree ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_notice_delivery_target_idx" ON "staff_notice_delivery" USING btree ("notice_id","channel","target");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_notice_delivery_status_idx" ON "staff_notice_delivery" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_notice_setting_kind_idx" ON "staff_notice_setting" USING btree ("organization_id","user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_text_consent_current_idx" ON "staff_text_consent" USING btree ("organization_id","user_id") WHERE "staff_text_consent"."superseded_at" is null;