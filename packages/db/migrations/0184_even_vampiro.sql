CREATE TYPE "public"."estimate_held_text_state" AS ENUM('waiting', 'sent', 'refused', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_change_order_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"change_order_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"crew_hours" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "estimate_held_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"state" "estimate_held_text_state" DEFAULT 'waiting' NOT NULL,
	"note" text NOT NULL,
	"expires_on" date NOT NULL,
	"link_until" timestamp with time zone NOT NULL,
	"held_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"reason" text,
	"delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ALTER COLUMN "purchase_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ALTER COLUMN "receipt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "expired_as_draft_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ADD COLUMN "stock_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "line_quantity_at_least" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "loose_quantity" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_hours" ADD CONSTRAINT "project_change_order_hours_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_hours" ADD CONSTRAINT "project_change_order_hours_change_order_id_project_change_order_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."project_change_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_change_order_hours" ADD CONSTRAINT "project_change_order_hours_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_receipt" ADD CONSTRAINT "stock_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
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
 ALTER TABLE "stock_receipt_movement" ADD CONSTRAINT "stock_receipt_movement_movement_id_stock_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_held_by_user_id_user_id_fk" FOREIGN KEY ("held_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_held_text" ADD CONSTRAINT "estimate_held_text_delivery_id_estimate_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."estimate_delivery"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_change_order_hours_job_idx" ON "project_change_order_hours" USING btree ("change_order_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipt_item_idx" ON "stock_receipt" USING btree ("organization_id","item_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipt_movement_receipt_idx" ON "stock_receipt_movement" USING btree ("stock_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_receipt_movement_movement_idx" ON "stock_receipt_movement" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_held_text_estimate_idx" ON "estimate_held_text" USING btree ("estimate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_held_text_one_waiting_idx" ON "estimate_held_text" USING btree ("estimate_id") WHERE "estimate_held_text"."state" = 'waiting';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_stock_receipt_id_stock_receipt_id_fk" FOREIGN KEY ("stock_receipt_id") REFERENCES "public"."stock_receipt"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_bill_stock_receipt_idx" ON "landed_cost_bill" USING btree ("stock_receipt_id","created_at") WHERE "landed_cost_bill"."stock_receipt_id" is not null;--> statement-breakpoint
ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_one_delivery" CHECK (("landed_cost_bill"."receipt_id" is not null and "landed_cost_bill"."purchase_order_id" is not null and "landed_cost_bill"."stock_receipt_id" is null)
      or ("landed_cost_bill"."receipt_id" is null and "landed_cost_bill"."purchase_order_id" is null and "landed_cost_bill"."stock_receipt_id" is not null));