CREATE TABLE IF NOT EXISTS "import_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"header_key" text NOT NULL,
	"columns" jsonb NOT NULL,
	"source" text NOT NULL,
	"day_first" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"source_key" text,
	"outcome" text DEFAULT 'waiting' NOT NULL,
	"reason" text,
	"record_id" uuid,
	"record_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"source" text NOT NULL,
	"day_first" boolean DEFAULT false NOT NULL,
	"header" jsonb NOT NULL,
	"columns" jsonb NOT NULL,
	"mapping_id" uuid,
	"status" text DEFAULT 'mapping' NOT NULL,
	"row_count" integer NOT NULL,
	"created_by_user_id" uuid,
	"checked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_mapping" ADD CONSTRAINT "import_mapping_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_mapping" ADD CONSTRAINT "import_mapping_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_row" ADD CONSTRAINT "import_row_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_row" ADD CONSTRAINT "import_row_run_id_import_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_run" ADD CONSTRAINT "import_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_run" ADD CONSTRAINT "import_run_mapping_id_import_mapping_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."import_mapping"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_run" ADD CONSTRAINT "import_run_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_mapping_name_idx" ON "import_mapping" USING btree ("organization_id","kind","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_mapping_header_idx" ON "import_mapping" USING btree ("organization_id","kind","header_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_row_number_idx" ON "import_row" USING btree ("run_id","row_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_row_outcome_idx" ON "import_row" USING btree ("run_id","outcome","row_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_run_org_idx" ON "import_run" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_source_ref_idx" ON "equipment" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;