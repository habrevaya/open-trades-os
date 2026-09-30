ALTER TABLE "message" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "body_html" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "headers" jsonb DEFAULT '{}'::jsonb NOT NULL;