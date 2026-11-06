ALTER TABLE "crew" ADD COLUMN "date_hours" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crew" ADD COLUMN "days_off" jsonb DEFAULT '[]'::jsonb NOT NULL;