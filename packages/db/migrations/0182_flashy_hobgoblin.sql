CREATE TABLE IF NOT EXISTS "stock_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"received_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_receipt_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stock_receipt_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ALTER COLUMN "purchase_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ALTER COLUMN "receipt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ADD COLUMN "stock_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "line_quantity_at_least" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "loose_quantity" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_received_by_user_id_user_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt_movement" ADD CONSTRAINT "stock_receipt_movement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt_movement" ADD CONSTRAINT "stock_receipt_movement_stock_receipt_id_stock_receipt_id_fk" FOREIGN KEY ("stock_receipt_id") REFERENCES "public"."stock_receipt"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt_movement" ADD CONSTRAINT "stock_receipt_movement_movement_id_stock_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movement"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipt_item_idx" ON "stock_receipt" USING btree ("organization_id","item_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipt_movement_receipt_idx" ON "stock_receipt_movement" USING btree ("stock_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_receipt_movement_movement_idx" ON "stock_receipt_movement" USING btree ("movement_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_stock_receipt_id_stock_receipt_id_fk" FOREIGN KEY ("stock_receipt_id") REFERENCES "public"."stock_receipt"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_bill_stock_receipt_idx" ON "landed_cost_bill" USING btree ("stock_receipt_id","created_at") WHERE "landed_cost_bill"."stock_receipt_id" is not null;--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_one_delivery" CHECK (("landed_cost_bill"."receipt_id" is not null and "landed_cost_bill"."purchase_order_id" is not null and "landed_cost_bill"."stock_receipt_id" is null)
      or ("landed_cost_bill"."receipt_id" is null and "landed_cost_bill"."purchase_order_id" is null and "landed_cost_bill"."stock_receipt_id" is not null));