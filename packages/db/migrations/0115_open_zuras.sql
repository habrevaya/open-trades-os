ALTER TABLE "invoice" ADD COLUMN "payer_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_payer_contact_id_contact_id_fk" FOREIGN KEY ("payer_contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
