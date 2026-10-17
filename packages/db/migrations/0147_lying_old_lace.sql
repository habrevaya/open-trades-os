ALTER TABLE "price_book_item" ADD COLUMN "chemical_unit" text;--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "epa_registration_number" text;--> statement-breakpoint
ALTER TABLE "service_report_field" ADD COLUMN "price_book_item_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report_field" ADD CONSTRAINT "service_report_field_price_book_item_id_price_book_item_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
