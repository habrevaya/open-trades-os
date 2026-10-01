CREATE TYPE "public"."calendar_feed_scope" AS ENUM('technician', 'company');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" "calendar_feed_scope" NOT NULL,
	"technician_id" uuid,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"label" text NOT NULL,
	"created_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text,
	"last_fetched_at" timestamp with time zone,
	"last_fetched_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_feed_token_idx" ON "calendar_feed" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_feed_org_idx" ON "calendar_feed" USING btree ("organization_id","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_feed_technician_idx" ON "calendar_feed" USING btree ("technician_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_provider_call_idx" ON "call" USING btree ("organization_id","provider_call_id") WHERE "call"."provider_call_id" is not null;