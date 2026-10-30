CREATE TABLE IF NOT EXISTS "tip_split_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid,
	"technician_id" uuid,
	"rule" text NOT NULL,
	"note" text,
	"set_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_split_override_subject" CHECK (("tip_split_override"."job_id" is not null) <> ("tip_split_override"."technician_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "tip_share" ADD COLUMN "rule_source" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tip_split_override" ADD CONSTRAINT "tip_split_override_set_by_user_id_user_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tip_split_override_job_idx" ON "tip_split_override" USING btree ("organization_id","job_id") WHERE "tip_split_override"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tip_split_override_technician_idx" ON "tip_split_override" USING btree ("organization_id","technician_id") WHERE "tip_split_override"."technician_id" is not null;