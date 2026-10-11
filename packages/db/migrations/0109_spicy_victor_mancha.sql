CREATE TABLE IF NOT EXISTS "accounting_branch_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_name" text NOT NULL,
	"external_group_id" text,
	"external_group_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX IF EXISTS "budget_line_cell_idx";--> statement-breakpoint
ALTER TABLE "accounting_entity_link" ADD COLUMN "deleted_noticed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounting_entity_link" ADD COLUMN "deletion_task_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_line" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_branch_mapping" ADD CONSTRAINT "accounting_branch_mapping_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_branch_mapping" ADD CONSTRAINT "accounting_branch_mapping_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_branch_mapping" ADD CONSTRAINT "accounting_branch_mapping_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_branch_mapping_branch_idx" ON "accounting_branch_mapping" USING btree ("connection_id","business_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_branch_mapping_org_idx" ON "accounting_branch_mapping" USING btree ("organization_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_entity_link" ADD CONSTRAINT "accounting_entity_link_deletion_task_id_task_id_fk" FOREIGN KEY ("deletion_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_branch_cell_idx" ON "budget_line" USING btree ("budget_id","business_unit_id","line","month") WHERE "budget_line"."business_unit_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_cell_idx" ON "budget_line" USING btree ("budget_id","line","month") WHERE "budget_line"."business_unit_id" is null;