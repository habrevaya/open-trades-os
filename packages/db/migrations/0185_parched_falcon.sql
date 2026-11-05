CREATE TABLE IF NOT EXISTS "project_change_order_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"change_order_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"crew_hours" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_hours" ADD CONSTRAINT "project_change_order_hours_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_hours" ADD CONSTRAINT "project_change_order_hours_change_order_id_project_change_order_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."project_change_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_hours" ADD CONSTRAINT "project_change_order_hours_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_change_order_hours_job_idx" ON "project_change_order_hours" USING btree ("change_order_id","job_id");