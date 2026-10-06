ALTER TABLE "custom_field_definition" ADD COLUMN "customer_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_object_record" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_object_record" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_object_record" ADD COLUMN "linked_record_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_object_type" ADD COLUMN "record_kind" text;--> statement-breakpoint
ALTER TABLE "custom_object_type" ADD COLUMN "customer_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_linked_record_id_custom_object_record_id_fk" FOREIGN KEY ("linked_record_id") REFERENCES "public"."custom_object_record"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_invoice_idx" ON "custom_object_record" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_membership_idx" ON "custom_object_record" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_linked_idx" ON "custom_object_record" USING btree ("linked_record_id");