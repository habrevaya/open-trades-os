ALTER TABLE "stock_receipt" DROP CONSTRAINT "stock_receipt_item_id_price_book_item_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_receipt" DROP CONSTRAINT "stock_receipt_location_id_location_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_receipt_movement" DROP CONSTRAINT "stock_receipt_movement_movement_id_stock_movement_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt_movement" ADD CONSTRAINT "stock_receipt_movement_movement_id_stock_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
