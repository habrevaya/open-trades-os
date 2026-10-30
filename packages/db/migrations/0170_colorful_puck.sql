ALTER TYPE "public"."budget_forecast_method" ADD VALUE 'blend';--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "forecast_weights" jsonb;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "seasonal_years" integer DEFAULT 1 NOT NULL;