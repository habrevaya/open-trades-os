ALTER TABLE "delivery_schedule" ADD COLUMN "built_in_dashboard" text;--> statement-breakpoint
ALTER TABLE "delivery_schedule" ADD COLUMN "dashboard_id" uuid;--> statement-breakpoint
ALTER TABLE "report_delivery" ADD COLUMN "built_in_dashboard" text;--> statement-breakpoint
ALTER TABLE "report_delivery" ADD COLUMN "dashboard_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_schedule" ADD CONSTRAINT "delivery_schedule_dashboard_id_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
