CREATE TYPE "public"."deposit_status" AS ENUM('requested', 'held', 'applied', 'refunded', 'forfeited');--> statement-breakpoint
CREATE TYPE "public"."signature_subject" AS ENUM('estimate', 'service_report', 'agreement', 'authorization');--> statement-breakpoint
CREATE TYPE "public"."booking_request_status" AS ENUM('pending', 'confirmed', 'declined', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."portal_event_kind" AS ENUM('booked', 'confirmed', 'scheduled', 'rescheduled', 'dispatched', 'on_the_way', 'arrived', 'in_progress', 'completed', 'cancelled', 'estimate_sent', 'estimate_viewed', 'estimate_approved', 'estimate_declined', 'invoice_sent', 'payment_received', 'report_published', 'message_sent');--> statement-breakpoint
CREATE TYPE "public"."portal_grant_scope" AS ENUM('estimate', 'job', 'invoice', 'customer');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deposit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"estimate_id" uuid,
	"job_id" uuid,
	"applied_invoice_id" uuid,
	"payment_id" uuid,
	"status" "deposit_status" DEFAULT 'requested' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount_requested" numeric(14, 4) NOT NULL,
	"amount_received" numeric(14, 4) DEFAULT '0' NOT NULL,
	"amount_applied" numeric(14, 4) DEFAULT '0' NOT NULL,
	"amount_refunded" numeric(14, 4) DEFAULT '0' NOT NULL,
	"percent_of_total" numeric(9, 6),
	"received_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject" "signature_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"signer_name" text NOT NULL,
	"signer_email" text,
	"signer_phone" text,
	"image_url" text,
	"document_hash" text NOT NULL,
	"selected_option_id" uuid,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"price_book_item_version_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(14, 4),
	"discount_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"tax_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"cost_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "arrival_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookable_service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_type_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"territory_id" uuid,
	"public_name" text NOT NULL,
	"public_description" text,
	"display_price" numeric(14, 4),
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"deposit_amount" numeric(14, 4),
	"deposit_percent" numeric(9, 6),
	"min_notice_hours" integer DEFAULT 24 NOT NULL,
	"max_advance_days" integer DEFAULT 60 NOT NULL,
	"max_per_window" integer DEFAULT 2 NOT NULL,
	"intake_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bookable_service_id" uuid NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"job_id" uuid,
	"status" "booking_request_status" DEFAULT 'pending' NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"requested_date" date NOT NULL,
	"arrival_window_id" uuid,
	"notes" text,
	"intake_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"referrer" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deposit_id" uuid,
	"decline_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"job_id" uuid,
	"estimate_id" uuid,
	"kind" "portal_event_kind" NOT NULL,
	"headline" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_customer_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"scope" "portal_grant_scope" NOT NULL,
	"subject_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposit" ADD CONSTRAINT "deposit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposit" ADD CONSTRAINT "deposit_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposit" ADD CONSTRAINT "deposit_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deposit" ADD CONSTRAINT "deposit_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_option_id_estimate_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."estimate_option"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_price_book_item_version_id_price_book_item_version_id_fk" FOREIGN KEY ("price_book_item_version_id") REFERENCES "public"."price_book_item_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "arrival_window" ADD CONSTRAINT "arrival_window_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookable_service" ADD CONSTRAINT "bookable_service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookable_service" ADD CONSTRAINT "bookable_service_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookable_service" ADD CONSTRAINT "bookable_service_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookable_service" ADD CONSTRAINT "bookable_service_territory_id_territory_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territory"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_bookable_service_id_bookable_service_id_fk" FOREIGN KEY ("bookable_service_id") REFERENCES "public"."bookable_service"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_arrival_window_id_arrival_window_id_fk" FOREIGN KEY ("arrival_window_id") REFERENCES "public"."arrival_window"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_event" ADD CONSTRAINT "portal_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_event" ADD CONSTRAINT "portal_event_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_event" ADD CONSTRAINT "portal_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_event" ADD CONSTRAINT "portal_event_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposit_org_idx" ON "deposit" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposit_customer_idx" ON "deposit" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_signature_subject_idx" ON "document_signature" USING btree ("organization_id","subject","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_line_option_idx" ON "estimate_line" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "arrival_window_org_idx" ON "arrival_window" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookable_service_org_idx" ON "bookable_service" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookable_service_job_type_idx" ON "bookable_service" USING btree ("job_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_request_org_idx" ON "booking_request" USING btree ("organization_id","status","requested_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_request_date_idx" ON "booking_request" USING btree ("organization_id","requested_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_event_customer_idx" ON "portal_event" USING btree ("organization_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_event_job_idx" ON "portal_event" USING btree ("job_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_grant_token_idx" ON "portal_grant" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_grant_subject_idx" ON "portal_grant" USING btree ("organization_id","scope","subject_id");