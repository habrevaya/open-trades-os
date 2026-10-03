CREATE TYPE "public"."portal_sign_in_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_sign_in" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" "portal_sign_in_channel" NOT NULL,
	"address" text NOT NULL,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"customer_id" uuid,
	"delivery" text,
	"request_key" text,
	"requested_ip" text,
	"signed_in_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_ref" text NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" integer,
	"exp_year" integer,
	"saved_by_grant_id" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tip_share" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid,
	"job_id" uuid,
	"technician_id" uuid NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_in_period_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_grant" ADD COLUMN "sign_in_id" uuid;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "shared_with_customer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "shared_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_sign_in" ADD CONSTRAINT "portal_sign_in_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_sign_in" ADD CONSTRAINT "portal_sign_in_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_profile" ADD CONSTRAINT "payment_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_profile" ADD CONSTRAINT "payment_profile_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_profile" ADD CONSTRAINT "payment_profile_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_payment_method" ADD CONSTRAINT "saved_payment_method_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_payment_method" ADD CONSTRAINT "saved_payment_method_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_payment_method" ADD CONSTRAINT "saved_payment_method_profile_id_payment_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."payment_profile"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_payment_method" ADD CONSTRAINT "saved_payment_method_saved_by_grant_id_portal_grant_id_fk" FOREIGN KEY ("saved_by_grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_share" ADD CONSTRAINT "tip_share_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_share" ADD CONSTRAINT "tip_share_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_share" ADD CONSTRAINT "tip_share_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_share" ADD CONSTRAINT "tip_share_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_share" ADD CONSTRAINT "tip_share_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_share" ADD CONSTRAINT "tip_share_paid_in_period_id_pay_period_id_fk" FOREIGN KEY ("paid_in_period_id") REFERENCES "public"."pay_period"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_sign_in_address_idx" ON "portal_sign_in" USING btree ("organization_id","address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_profile_customer_idx" ON "payment_profile" USING btree ("organization_id","connection_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saved_payment_method_external_idx" ON "saved_payment_method" USING btree ("organization_id","external_ref") WHERE "saved_payment_method"."removed_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_payment_method_customer_idx" ON "saved_payment_method" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tip_share_payment_idx" ON "tip_share" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tip_share_invoice_idx" ON "tip_share" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tip_share_technician_idx" ON "tip_share" USING btree ("organization_id","technician_id","occurred_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_sign_in_id_portal_sign_in_id_fk" FOREIGN KEY ("sign_in_id") REFERENCES "public"."portal_sign_in"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_shared_by_user_id_user_id_fk" FOREIGN KEY ("shared_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
