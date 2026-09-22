CREATE TYPE "public"."call_status" AS ENUM('ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'voicemail', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."comm_channel" AS ENUM('sms', 'mms', 'voice', 'email', 'webchat');--> statement-breakpoint
CREATE TYPE "public"."comm_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."comm_purpose" AS ENUM('transactional', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."consent_method" AS ENUM('web_form', 'verbal', 'written', 'sms_reply', 'checkout', 'imported', 'api');--> statement-breakpoint
CREATE TYPE "public"."consent_state" AS ENUM('granted', 'revoked', 'pending');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'snoozed', 'closed', 'spam');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received');--> statement-breakpoint
CREATE TYPE "public"."phone_number_purpose" AS ENUM('main', 'tracking', 'user', 'sending', 'fax');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('not_started', 'submitted', 'pending_review', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"direction" "comm_direction" NOT NULL,
	"phone_number_id" uuid,
	"received_on_e164" text,
	"from_e164" text NOT NULL,
	"to_e164" text NOT NULL,
	"customer_id" uuid,
	"contact_id" uuid,
	"job_id" uuid,
	"conversation_id" uuid,
	"answered_by_user_id" uuid,
	"status" "call_status" NOT NULL,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"ring_seconds" integer,
	"recording_url" text,
	"recording_consent" text,
	"recording_deleted_at" timestamp with time zone,
	"voicemail_url" text,
	"transcript" text,
	"disposition" text,
	"attribution_source" text,
	"provider_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "communication_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid,
	"contact_id" uuid,
	"address" text NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"purpose" "comm_purpose" NOT NULL,
	"state" "consent_state" NOT NULL,
	"method" "consent_method" NOT NULL,
	"proof_text" text,
	"proof_reference" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_by_user_id" uuid,
	"ip_address" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"external_address" text NOT NULL,
	"phone_number_id" uuid,
	"internal_address" text,
	"customer_id" uuid,
	"contact_id" uuid,
	"job_id" uuid,
	"subject" text,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "comm_direction" NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"purpose" "comm_purpose" DEFAULT 'transactional' NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"body" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "message_status" NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"consent_id" uuid,
	"sent_by_user_id" uuid,
	"automation_ref" text,
	"template_id" uuid,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"purpose" "comm_purpose" DEFAULT 'transactional' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_brand" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"external_brand_id" text,
	"entity_type" text,
	"tax_id_last4" text,
	"website" text,
	"status" "registration_status" DEFAULT 'not_started' NOT NULL,
	"status_reason" text,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"purpose" "comm_purpose" NOT NULL,
	"use_case" text NOT NULL,
	"description" text,
	"external_campaign_id" text,
	"status" "registration_status" DEFAULT 'not_started' NOT NULL,
	"status_reason" text,
	"opt_in_description" text,
	"sample_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"messages_per_second" integer,
	"daily_cap" integer,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "phone_number" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"business_unit_id" uuid,
	"e164" text NOT NULL,
	"label" text,
	"purpose" "phone_number_purpose" DEFAULT 'main' NOT NULL,
	"campaign_id" uuid,
	"user_id" uuid,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"forwards_to_e164" text,
	"attribution_source" text,
	"sms_registered" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"address" text NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"purpose" "comm_purpose",
	"reason" text NOT NULL,
	"source_message_id" uuid,
	"lifted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_answered_by_user_id_user_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_captured_by_user_id_user_id_fk" FOREIGN KEY ("captured_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_phone_number_id_phone_number_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_number"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message" ADD CONSTRAINT "message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message" ADD CONSTRAINT "message_consent_id_communication_consent_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."communication_consent"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message" ADD CONSTRAINT "message_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_template" ADD CONSTRAINT "message_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messaging_brand" ADD CONSTRAINT "messaging_brand_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messaging_brand" ADD CONSTRAINT "messaging_brand_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messaging_campaign" ADD CONSTRAINT "messaging_campaign_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messaging_campaign" ADD CONSTRAINT "messaging_campaign_brand_id_messaging_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."messaging_brand"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_campaign_id_messaging_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."messaging_campaign"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppression" ADD CONSTRAINT "suppression_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_org_idx" ON "call" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_customer_idx" ON "call" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_number_idx" ON "call" USING btree ("organization_id","received_on_e164");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_consent_lookup_idx" ON "communication_consent" USING btree ("organization_id","address","channel","purpose","superseded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_consent_customer_idx" ON "communication_consent" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_inbox_idx" ON "conversation" USING btree ("organization_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_address_idx" ON "conversation" USING btree ("organization_id","channel","external_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_customer_idx" ON "conversation" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_job_idx" ON "conversation" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_thread_idx" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_provider_idx" ON "message" USING btree ("organization_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_template_code_idx" ON "message_template" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_brand_org_idx" ON "messaging_brand" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_campaign_brand_idx" ON "messaging_campaign" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_number_org_idx" ON "phone_number" USING btree ("organization_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_number_live_idx" ON "phone_number" USING btree ("organization_id","e164") WHERE "phone_number"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppression_live_purpose_idx" ON "suppression" USING btree ("organization_id","address","channel","purpose") WHERE "suppression"."lifted_at" is null and "suppression"."purpose" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppression_live_all_idx" ON "suppression" USING btree ("organization_id","address","channel") WHERE "suppression"."lifted_at" is null and "suppression"."purpose" is null;