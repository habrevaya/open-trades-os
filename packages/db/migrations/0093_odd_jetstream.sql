ALTER TABLE "project_application" ADD COLUMN "retainage_booked" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "project_application" ADD COLUMN "retainage_reversed_at" timestamp with time zone;