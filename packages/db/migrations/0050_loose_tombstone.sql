CREATE TYPE "public"."compliance_document_state" AS ENUM('active', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"reference" text,
	"issuer_name" text,
	"jurisdiction" text,
	"subject_type" text,
	"subject_id" uuid,
	"issued_on" date,
	"expires_on" date,
	"notice_days" integer DEFAULT 30 NOT NULL,
	"required_for_work" boolean DEFAULT false NOT NULL,
	"state" "compliance_document_state" DEFAULT 'active' NOT NULL,
	"supersedes_id" uuid,
	"withdrawn_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compliance_document" ADD CONSTRAINT "compliance_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_document_expiry_idx" ON "compliance_document" USING btree ("organization_id","state","expires_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_document_subject_idx" ON "compliance_document" USING btree ("organization_id","subject_type","subject_id");