CREATE TYPE "public"."commission_on_payment_outcome" AS ENUM('settled', 'left');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_on_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"outcome" "commission_on_payment_outcome" NOT NULL,
	"reason" text,
	"commission_event_id" uuid,
	"event_sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "coverage_claim" ADD COLUMN "billed_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "coverage_claim" ADD COLUMN "billed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_on_payment" ADD CONSTRAINT "commission_on_payment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_on_payment" ADD CONSTRAINT "commission_on_payment_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission_on_payment" ADD CONSTRAINT "commission_on_payment_commission_event_id_commission_event_id_fk" FOREIGN KEY ("commission_event_id") REFERENCES "public"."commission_event"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_on_payment_invoice_idx" ON "commission_on_payment" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_on_payment_outcome_idx" ON "commission_on_payment" USING btree ("organization_id","outcome","updated_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverage_claim" ADD CONSTRAINT "coverage_claim_billed_invoice_id_invoice_id_fk" FOREIGN KEY ("billed_invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
