ALTER TABLE "equipment" ADD COLUMN "warranty_registered_on" date;--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "warranty_registration_reference" text;--> statement-breakpoint
ALTER TABLE "price_book_item_version" ADD COLUMN "warranty_registration_days" integer;