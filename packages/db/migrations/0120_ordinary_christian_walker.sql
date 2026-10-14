CREATE TABLE IF NOT EXISTS "call_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"from_user_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"to_destination" jsonb,
	"to_user_id" uuid,
	"consult_leg_sid" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "handled_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_transfer" ADD CONSTRAINT "call_transfer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_transfer" ADD CONSTRAINT "call_transfer_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_transfer" ADD CONSTRAINT "call_transfer_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_transfer" ADD CONSTRAINT "call_transfer_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transfer_call_idx" ON "call_transfer" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_transfer_open_idx" ON "call_transfer" USING btree ("call_id") WHERE "call_transfer"."status" in ('holding', 'consulting', 'handing_over');--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call" ADD CONSTRAINT "call_handled_by_user_id_user_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
