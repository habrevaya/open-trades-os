CREATE TABLE IF NOT EXISTS "workflow_schedule" (
	"organization_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"expression" text NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_schedule_organization_id_workflow_id_pk" PRIMARY KEY("organization_id","workflow_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_schedule" ADD CONSTRAINT "workflow_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_schedule" ADD CONSTRAINT "workflow_schedule_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_schedule_due_idx" ON "workflow_schedule" USING btree ("next_run_at") WHERE "workflow_schedule"."next_run_at" is not null;