CREATE TYPE "public"."purchase_approval_amount_of" AS ENUM('order', 'matching_lines');--> statement-breakpoint
ALTER TABLE "disposal_facility" ADD COLUMN "holidays" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "amount_of" "purchase_approval_amount_of" DEFAULT 'order' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_approval" ADD COLUMN "counted_total" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "second_part_number" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_item_second_part_number_idx" ON "vendor_item" USING btree ("organization_id","vendor_id",lower("second_part_number")) WHERE "vendor_item"."second_part_number" is not null;--> statement-breakpoint
ALTER TABLE "vendor_item" ADD CONSTRAINT "vendor_item_second_number" CHECK ("vendor_item"."second_part_number" is null or ("vendor_item"."second_pack_quantity" is not null and lower("vendor_item"."second_part_number") <> lower("vendor_item"."part_number")));