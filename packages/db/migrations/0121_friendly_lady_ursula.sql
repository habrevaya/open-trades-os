ALTER TABLE "vendor_item" ADD COLUMN "second_pack_quantity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "second_purchase_unit" text;--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "second_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "second_price_breaks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_item" ADD CONSTRAINT "vendor_item_two_packs" CHECK ("vendor_item"."second_pack_quantity" is null or "vendor_item"."second_pack_quantity" <> "vendor_item"."pack_quantity");