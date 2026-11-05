CREATE TYPE "public"."estimate_held_text_state" AS ENUM('waiting', 'sent', 'refused', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate_held_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"state" "estimate_held_text_state" DEFAULT 'waiting' NOT NULL,
	"note" text NOT NULL,
	"expires_on" date NOT NULL,
	"link_until" timestamp with time zone NOT NULL,
	"held_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"reason" text,
	"delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_held_by_user_id_user_id_fk" FOREIGN KEY ("held_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_delivery_id_estimate_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."estimate_delivery"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_held_text_estimate_idx" ON "estimate_held_text" USING btree ("estimate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_held_text_one_waiting_idx" ON "estimate_held_text" USING btree ("estimate_id") WHERE "estimate_held_text"."state" = 'waiting';