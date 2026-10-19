ALTER TABLE "price_book_item_version" ADD COLUMN "buy_unit" text;--> statement-breakpoint
ALTER TABLE "price_book_item_version" ADD COLUMN "use_unit" text;--> statement-breakpoint
ALTER TABLE "price_book_item_version" ADD COLUMN "use_per_buy" numeric(14, 6);