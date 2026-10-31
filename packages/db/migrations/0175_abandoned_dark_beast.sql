CREATE TABLE IF NOT EXISTS "inspection_program_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"standard" text,
	"report_audience" text DEFAULT 'customer' NOT NULL,
	"authority_name" text,
	"frequency_months" integer,
	"checkpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"trade_pack_id" text,
	"published_by_user_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection_program" ADD COLUMN "copied_from" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_program_version" ADD CONSTRAINT "inspection_program_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_program_version" ADD CONSTRAINT "inspection_program_version_program_id_inspection_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."inspection_program"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_program_version" ADD CONSTRAINT "inspection_program_version_published_by_user_id_user_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_program_version_idx" ON "inspection_program_version" USING btree ("program_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_program_version_org_idx" ON "inspection_program_version" USING btree ("organization_id");