CREATE TYPE "public"."budget_forecast_method" AS ENUM('budget', 'run_rate');--> statement-breakpoint
DROP INDEX IF EXISTS "costing_rate_day_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "budget_line_cell_idx";--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "forecast_method" "budget_forecast_method" DEFAULT 'budget' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_line" ADD COLUMN "job_type_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_job_type_cell_idx" ON "budget_line" USING btree ("budget_id","job_type_id","line","month") WHERE "budget_line"."job_type_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "costing_rate_part_day_idx" ON "costing_rate" USING btree ("organization_id","component","basis","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_cell_idx" ON "budget_line" USING btree ("budget_id","line","month") WHERE "budget_line"."business_unit_id" is null and "budget_line"."job_type_id" is null;--> statement-breakpoint
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_one_scope" CHECK ("budget_line"."business_unit_id" is null or "budget_line"."job_type_id" is null);