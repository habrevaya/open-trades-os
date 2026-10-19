ALTER TABLE "coverage_claim" ADD COLUMN "billed_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "coverage_claim" ADD COLUMN "billed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coverage_claim" ADD CONSTRAINT "coverage_claim_billed_invoice_id_invoice_id_fk" FOREIGN KEY ("billed_invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
