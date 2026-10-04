CREATE TYPE "public"."vendor_return_status" AS ENUM('awaiting_credit', 'credited');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_kind" ADD VALUE 'numbered';--> statement-breakpoint
ALTER TYPE "public"."stock_movement_kind" ADD VALUE 'revaluation';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "landed_cost_bill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"basis" "landed_cost_basis" NOT NULL,
	"total" numeric(14, 4) NOT NULL,
	"reference" text,
	"on_shelf" numeric(14, 4) NOT NULL,
	"on_jobs" numeric(14, 4) NOT NULL,
	"on_gone" numeric(14, 4) NOT NULL,
	"ledger_transaction_id" uuid,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "landed_cost_bill_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_approval_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"user_id" uuid,
	"destination" text NOT NULL,
	"state" text NOT NULL,
	"explanation" text,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "vendor_return_status" DEFAULT 'awaiting_credit' NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"credit_expected" numeric(14, 4) NOT NULL,
	"credit_received" numeric(14, 4),
	"credit_received_at" timestamp with time zone,
	"credit_reference" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX IF EXISTS "purchase_order_approval_step_idx";--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_approval_rule" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_approval" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "pack_quantity" numeric(14, 4) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "purchase_unit" text;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "pack_price" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "revalues_movement_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "late_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "landed_cost_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "vendor_return_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "pack_quantity" numeric(14, 4) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "purchase_unit" text;--> statement-breakpoint
ALTER TABLE "vendor_item" ADD COLUMN "price_breaks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_receipt_id_purchase_order_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_order_receipt"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill" ADD CONSTRAINT "landed_cost_bill_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill_charge" ADD CONSTRAINT "landed_cost_bill_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "landed_cost_bill_charge" ADD CONSTRAINT "landed_cost_bill_charge_bill_id_landed_cost_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."landed_cost_bill"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval_notice" ADD CONSTRAINT "purchase_order_approval_notice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval_notice" ADD CONSTRAINT "purchase_order_approval_notice_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval_notice" ADD CONSTRAINT "purchase_order_approval_notice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_return" ADD CONSTRAINT "vendor_return_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_return" ADD CONSTRAINT "vendor_return_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_return" ADD CONSTRAINT "vendor_return_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_bill_receipt_idx" ON "landed_cost_bill" USING btree ("receipt_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_bill_charge_bill_idx" ON "landed_cost_bill_charge" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_approval_notice_order_idx" ON "purchase_order_approval_notice" USING btree ("purchase_order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_return_number_idx" ON "vendor_return" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_return_vendor_idx" ON "vendor_return" USING btree ("organization_id","vendor_id","status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_approval_rule" ADD CONSTRAINT "purchase_approval_rule_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_approval_rule" ADD CONSTRAINT "purchase_approval_rule_category_id_price_book_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_book_category"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_approval_rule" ADD CONSTRAINT "purchase_approval_rule_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_landed_cost_bill_id_landed_cost_bill_id_fk" FOREIGN KEY ("landed_cost_bill_id") REFERENCES "public"."landed_cost_bill"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_vendor_return_id_vendor_return_id_fk" FOREIGN KEY ("vendor_return_id") REFERENCES "public"."vendor_return"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_approval_step_idx" ON "purchase_order_approval" USING btree ("purchase_order_id","step") WHERE "purchase_order_approval"."superseded_at" is null;