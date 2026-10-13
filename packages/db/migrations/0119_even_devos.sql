ALTER TABLE "attachment" ADD COLUMN "uploaded_by_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "uploaded_by_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "seen_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_seen_by_user_id_user_id_fk" FOREIGN KEY ("seen_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachment_customer_idx" ON "attachment" USING btree ("organization_id","uploaded_by_customer_id","created_at");