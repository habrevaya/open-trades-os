CREATE TABLE IF NOT EXISTS "statement_delivery_copy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_delivery_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"contact_id" uuid,
	"recipient_name" text,
	"channel" text NOT NULL,
	"destination" text,
	"typed" boolean DEFAULT false NOT NULL,
	"message_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "reopened_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery_copy" ADD CONSTRAINT "statement_delivery_copy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery_copy" ADD CONSTRAINT "statement_delivery_copy_statement_delivery_id_statement_delivery_id_fk" FOREIGN KEY ("statement_delivery_id") REFERENCES "public"."statement_delivery"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery_copy" ADD CONSTRAINT "statement_delivery_copy_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery_copy" ADD CONSTRAINT "statement_delivery_copy_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_delivery_copy_delivery_idx" ON "statement_delivery_copy" USING btree ("statement_delivery_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation" ADD CONSTRAINT "conversation_reopened_by_user_id_user_id_fk" FOREIGN KEY ("reopened_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
