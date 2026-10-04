ALTER TYPE "public"."member_role" ADD VALUE 'branch_manager';--> statement-breakpoint
ALTER TYPE "public"."signature_subject" ADD VALUE 'staff_document';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"email" text NOT NULL,
	"sent_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"email_refusal" text,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_document_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"signed_at" timestamp with time zone,
	"signed_via" text,
	"signature_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "number_prefix" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "number_prefix" text;--> statement-breakpoint
ALTER TABLE "onboarding_item" ADD COLUMN "staff_document_id" uuid;--> statement-breakpoint
ALTER TABLE "onboarding_template_item" ADD COLUMN "staff_document_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "sealed_invite_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_invite" ADD CONSTRAINT "membership_invite_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_invite" ADD CONSTRAINT "membership_invite_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_invite" ADD CONSTRAINT "membership_invite_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_document" ADD CONSTRAINT "staff_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_document" ADD CONSTRAINT "staff_document_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_document_request" ADD CONSTRAINT "staff_document_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_document_request" ADD CONSTRAINT "staff_document_request_document_id_staff_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."staff_document"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_document_request" ADD CONSTRAINT "staff_document_request_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_document_request" ADD CONSTRAINT "staff_document_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_invite_member_idx" ON "membership_invite" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_document_org_idx" ON "staff_document" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_document_request_person_idx" ON "staff_document_request" USING btree ("document_id","membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_document_request_member_idx" ON "staff_document_request" USING btree ("organization_id","membership_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_staff_document_id_staff_document_id_fk" FOREIGN KEY ("staff_document_id") REFERENCES "public"."staff_document"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_template_item" ADD CONSTRAINT "onboarding_template_item_staff_document_id_staff_document_id_fk" FOREIGN KEY ("staff_document_id") REFERENCES "public"."staff_document"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message" ADD CONSTRAINT "message_sealed_invite_id_membership_invite_id_fk" FOREIGN KEY ("sealed_invite_id") REFERENCES "public"."membership_invite"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
