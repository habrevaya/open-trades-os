ALTER TABLE "customer_merge" ADD COLUMN "stayed" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_merge" ADD COLUMN "superseded" jsonb DEFAULT '[]'::jsonb NOT NULL;