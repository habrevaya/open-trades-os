ALTER TABLE "price_book_item" ADD COLUMN "quantity_is_crew_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "budget_estimate_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "quantity_is_crew_hours" boolean DEFAULT false NOT NULL;