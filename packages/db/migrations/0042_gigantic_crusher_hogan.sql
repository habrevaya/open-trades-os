CREATE TABLE IF NOT EXISTS "setup_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "setup_token" ADD CONSTRAINT "setup_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "setup_token_token_idx" ON "setup_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "setup_token_user_idx" ON "setup_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_external_ref_idx" ON "organization" USING btree ("external_ref") WHERE "organization"."external_ref" is not null;