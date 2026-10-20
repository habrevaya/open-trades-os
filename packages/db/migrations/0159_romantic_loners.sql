ALTER TYPE "public"."budget_forecast_method" ADD VALUE 'seasonal';--> statement-breakpoint
ALTER TABLE "budget_line" DROP CONSTRAINT "budget_line_one_scope";--> statement-breakpoint
DROP INDEX IF EXISTS "budget_line_branch_cell_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "budget_line_job_type_cell_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_branch_job_type_cell_idx" ON "budget_line" USING btree ("budget_id","business_unit_id","job_type_id","line","month") WHERE "budget_line"."business_unit_id" is not null and "budget_line"."job_type_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_branch_cell_idx" ON "budget_line" USING btree ("budget_id","business_unit_id","line","month") WHERE "budget_line"."business_unit_id" is not null and "budget_line"."job_type_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_job_type_cell_idx" ON "budget_line" USING btree ("budget_id","job_type_id","line","month") WHERE "budget_line"."job_type_id" is not null and "budget_line"."business_unit_id" is null;