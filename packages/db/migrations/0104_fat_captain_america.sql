CREATE TYPE "public"."truck_fill_status" AS ENUM('open', 'confirmed', 'dismissed', 'withdrawn');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "truck_fill_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"status" "truck_fill_status" DEFAULT 'open' NOT NULL,
	"proposed_on" date NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "truck_fill_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"on_truck" numeric(14, 4) NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"why" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_draft" ADD CONSTRAINT "truck_fill_draft_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_draft" ADD CONSTRAINT "truck_fill_draft_truck_id_location_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_draft_id_truck_fill_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."truck_fill_draft"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_from_location_id_location_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_fill_draft_open_idx" ON "truck_fill_draft" USING btree ("organization_id","truck_id") WHERE "truck_fill_draft"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truck_fill_draft_truck_idx" ON "truck_fill_draft" USING btree ("organization_id","truck_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truck_fill_line_draft_idx" ON "truck_fill_line" USING btree ("organization_id","draft_id");