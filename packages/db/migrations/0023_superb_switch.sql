ALTER TABLE "arrival_notice" ADD COLUMN "message_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "arrival_notice" ADD CONSTRAINT "arrival_notice_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
