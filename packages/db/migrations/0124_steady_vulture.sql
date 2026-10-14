CREATE TYPE "public"."sync_run_outcome" AS ENUM('sent', 'found', 'refused');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_run_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"link_id" uuid,
	"kind" "accounting_entity_kind" NOT NULL,
	"entity_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"outcome" "sync_run_outcome" NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX IF EXISTS "accounting_period_end_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_run_document" ADD CONSTRAINT "sync_run_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_run_document" ADD CONSTRAINT "sync_run_document_run_id_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_run_document" ADD CONSTRAINT "sync_run_document_link_id_accounting_entity_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."accounting_entity_link"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_run_document_run_idx" ON "sync_run_document" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_run_document_org_idx" ON "sync_run_document" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_period_end_idx" ON "accounting_period" USING btree ("organization_id","period_end") WHERE "accounting_period"."reopened_at" is null;