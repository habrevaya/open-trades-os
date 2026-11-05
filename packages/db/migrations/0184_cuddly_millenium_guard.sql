ALTER TABLE "budget" ADD COLUMN "run_rate_recent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "line_blends" jsonb DEFAULT '{}'::jsonb NOT NULL;