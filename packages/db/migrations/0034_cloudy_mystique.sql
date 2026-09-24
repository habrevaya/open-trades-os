ALTER TABLE "recurring_schedule" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_schedule" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_schedule" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_schedule" ADD COLUMN "job_type_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_schedule" ADD COLUMN "summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_schedule" ADD COLUMN "estimated_duration_minutes" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
