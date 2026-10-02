CREATE TABLE IF NOT EXISTS "integration_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sealed_secret" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_last4" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_secret" ADD CONSTRAINT "integration_secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_secret_org_name_idx" ON "integration_secret" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_secret_key_idx" ON "integration_secret" USING btree ("key_id");