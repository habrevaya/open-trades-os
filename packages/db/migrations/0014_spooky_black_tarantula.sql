CREATE TYPE "public"."connected_app_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"hint" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connected_app" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"publisher" text,
	"description" text,
	"homepage_url" text,
	"status" "connected_app_status" DEFAULT 'pending' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by_user_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "booking_request" ADD COLUMN "connected_app_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_token" ADD CONSTRAINT "app_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_token" ADD CONSTRAINT "app_token_app_id_connected_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."connected_app"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_token" ADD CONSTRAINT "app_token_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_app" ADD CONSTRAINT "connected_app_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_app" ADD CONSTRAINT "connected_app_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_app" ADD CONSTRAINT "connected_app_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connected_app" ADD CONSTRAINT "connected_app_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_token_hash_idx" ON "app_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_token_app_idx" ON "app_token" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connected_app_org_idx" ON "connected_app" USING btree ("organization_id","status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_request" ADD CONSTRAINT "booking_request_connected_app_id_connected_app_id_fk" FOREIGN KEY ("connected_app_id") REFERENCES "public"."connected_app"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
