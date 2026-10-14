CREATE TYPE "public"."purchase_approval_amount_of" AS ENUM('order', 'matching_lines');--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "amount_of" "purchase_approval_amount_of" DEFAULT 'order' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_approval" ADD COLUMN "counted_total" numeric(14, 4);