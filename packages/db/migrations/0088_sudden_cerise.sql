CREATE TABLE IF NOT EXISTS "proposal_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"job_type_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"cover" jsonb,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"show_option_photos" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_object_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"object_type_id" uuid NOT NULL,
	"title" text NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"job_id" uuid,
	"equipment_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_object_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"plural_label" text NOT NULL,
	"description" text,
	"title_label" text DEFAULT 'Name' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_permission" text DEFAULT 'record:read' NOT NULL,
	"write_permission" text DEFAULT 'record:write' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "sandbox_of_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "sandbox_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "sandbox_discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "technician" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "proposal_template_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "proposal_layout" jsonb;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposal_template" ADD CONSTRAINT "proposal_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposal_template" ADD CONSTRAINT "proposal_template_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposal_template" ADD CONSTRAINT "proposal_template_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_object_type_id_custom_object_type_id_fk" FOREIGN KEY ("object_type_id") REFERENCES "public"."custom_object_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_record" ADD CONSTRAINT "custom_object_record_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_type" ADD CONSTRAINT "custom_object_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_object_type" ADD CONSTRAINT "custom_object_type_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proposal_template_name_idx" ON "proposal_template" USING btree ("organization_id","name") WHERE "proposal_template"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proposal_template_job_type_idx" ON "proposal_template" USING btree ("organization_id","job_type_id") WHERE "proposal_template"."deleted_at" is null and "proposal_template"."job_type_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proposal_template_default_idx" ON "proposal_template" USING btree ("organization_id") WHERE "proposal_template"."deleted_at" is null and "proposal_template"."is_default";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_type_idx" ON "custom_object_record" USING btree ("organization_id","object_type_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_job_idx" ON "custom_object_record" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_customer_idx" ON "custom_object_record" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_property_idx" ON "custom_object_record" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_object_record_equipment_idx" ON "custom_object_record" USING btree ("equipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_object_type_key_idx" ON "custom_object_type" USING btree ("organization_id","key") WHERE "custom_object_type"."deleted_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization" ADD CONSTRAINT "organization_sandbox_of_organization_id_organization_id_fk" FOREIGN KEY ("sandbox_of_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization" ADD CONSTRAINT "organization_sandbox_organization_id_organization_id_fk" FOREIGN KEY ("sandbox_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_proposal_template_id_proposal_template_id_fk" FOREIGN KEY ("proposal_template_id") REFERENCES "public"."proposal_template"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
