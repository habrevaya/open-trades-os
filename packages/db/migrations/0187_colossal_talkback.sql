ALTER TABLE "business_hours_season" ADD COLUMN "starts_rule" jsonb;--> statement-breakpoint
ALTER TABLE "business_hours_season" ADD COLUMN "ends_rule" jsonb;--> statement-breakpoint
ALTER TABLE "business_hours_season" ADD COLUMN "only_some_days" boolean DEFAULT false NOT NULL;