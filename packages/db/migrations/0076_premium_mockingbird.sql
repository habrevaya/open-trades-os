CREATE TYPE "public"."price_book_fee_role" AS ENUM('diagnostic', 'after_hours');--> statement-breakpoint
CREATE TYPE "public"."estimate_delivery_channel" AS ENUM('email', 'sms', 'link');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"part_number" text NOT NULL,
	"description" text,
	"cost" numeric(14, 4),
	"cost_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"channel" "estimate_delivery_channel" NOT NULL,
	"destination" text,
	"message_id" uuid,
	"portal_grant_id" uuid,
	"error" text,
	"sent_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "fee_role" "price_book_fee_role";--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "terms" text;--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "discount_rate" numeric(9, 6);--> statement-breakpoint
-- Agreements sold before the rate was frozen on them take their plan's rate as it stands
-- today, which is the rate they have been priced at every day until now.
UPDATE "agreement" a SET "discount_rate" = p."discount_rate" FROM "agreement_plan" p WHERE p."id" = a."plan_id";--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "vendor_part_number" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_item" ADD CONSTRAINT "vendor_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_item" ADD CONSTRAINT "vendor_item_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_item" ADD CONSTRAINT "vendor_item_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_delivery" ADD CONSTRAINT "estimate_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_delivery" ADD CONSTRAINT "estimate_delivery_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_delivery" ADD CONSTRAINT "estimate_delivery_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_delivery" ADD CONSTRAINT "estimate_delivery_portal_grant_id_portal_grant_id_fk" FOREIGN KEY ("portal_grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_delivery" ADD CONSTRAINT "estimate_delivery_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_item_vendor_item_idx" ON "vendor_item" USING btree ("organization_id","vendor_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_item_part_number_idx" ON "vendor_item" USING btree ("organization_id","vendor_id",lower("part_number"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_item_item_idx" ON "vendor_item" USING btree ("organization_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_delivery_estimate_idx" ON "estimate_delivery" USING btree ("estimate_id","created_at");