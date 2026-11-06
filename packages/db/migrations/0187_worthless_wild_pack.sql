ALTER TABLE "price_book_item" ADD COLUMN "pack_marks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "business_hours_season" ADD COLUMN "starts_rule" jsonb;--> statement-breakpoint
ALTER TABLE "business_hours_season" ADD COLUMN "ends_rule" jsonb;--> statement-breakpoint
ALTER TABLE "business_hours_season" ADD COLUMN "only_some_days" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crew" ADD COLUMN "date_hours" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crew" ADD COLUMN "days_off" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_type" ADD COLUMN "pack_marks" jsonb DEFAULT '[]'::jsonb NOT NULL;