ALTER TABLE "price_book_item" ADD COLUMN "pack_marks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_type" ADD COLUMN "pack_marks" jsonb DEFAULT '[]'::jsonb NOT NULL;