ALTER TABLE "project_change_order" ADD COLUMN "schedule_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "schedule_applied_by" uuid;--> statement-breakpoint
ALTER TABLE "project_change_order" ADD COLUMN "schedule_applied" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order" ADD CONSTRAINT "project_change_order_schedule_applied_by_user_id_fk" FOREIGN KEY ("schedule_applied_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
