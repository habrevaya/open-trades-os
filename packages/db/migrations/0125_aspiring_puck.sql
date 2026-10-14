ALTER TABLE "customer" ADD COLUMN "statement_copy_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "copy_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "copy_destination" text;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "copy_message_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "copy_error" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer" ADD CONSTRAINT "customer_statement_copy_contact_id_contact_id_fk" FOREIGN KEY ("statement_copy_contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_copy_contact_id_contact_id_fk" FOREIGN KEY ("copy_contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_copy_message_id_message_id_fk" FOREIGN KEY ("copy_message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
