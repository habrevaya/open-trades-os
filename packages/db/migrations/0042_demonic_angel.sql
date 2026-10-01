ALTER TABLE "invoice_delivery" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_delivery" ADD COLUMN "portal_grant_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_portal_grant_id_portal_grant_id_fk" FOREIGN KEY ("portal_grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
