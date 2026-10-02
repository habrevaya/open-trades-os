CREATE TABLE IF NOT EXISTS "demo_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "demo_user_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_visit_ip_idx" ON "demo_visit" USING btree ("ip_hash","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization" ADD CONSTRAINT "organization_demo_user_id_user_id_fk" FOREIGN KEY ("demo_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
