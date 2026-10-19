ALTER TABLE "disposal_facility" ADD COLUMN "materials" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "came_back_empty_at" timestamp with time zone;