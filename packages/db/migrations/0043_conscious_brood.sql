ALTER TABLE "route" ADD COLUMN "travel_minutes_between_stops" integer;--> statement-breakpoint
ALTER TABLE "job_type" ADD COLUMN "required_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;