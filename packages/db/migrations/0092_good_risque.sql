ALTER TABLE "customer" ADD COLUMN "preferred_days" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "collection_agreed_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "collection_agreed_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "movable_from" date;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "movable_until" date;