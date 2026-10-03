ALTER TABLE "contact" ADD COLUMN "portal_access_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "customer_notes" text;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "customer_notes_shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_request" ADD COLUMN "preferred_technician_id" uuid;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "portal_grant" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "portal_sign_in" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "portal_sign_in" ADD COLUMN "matched_customer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_payment_method" ADD COLUMN "kind" text DEFAULT 'card' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_preferred_technician_id_technician_id_fk" FOREIGN KEY ("preferred_technician_id") REFERENCES "public"."technician"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_grant" ADD CONSTRAINT "portal_grant_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_sign_in" ADD CONSTRAINT "portal_sign_in_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_grant_customer_idx" ON "portal_grant" USING btree ("organization_id","customer_id","created_at");