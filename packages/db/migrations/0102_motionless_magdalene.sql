CREATE TABLE IF NOT EXISTS "after_hours_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"after_hours_item_id" uuid,
	"holiday_item_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "after_hours_rate" ADD CONSTRAINT "after_hours_rate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "after_hours_rate" ADD CONSTRAINT "after_hours_rate_after_hours_item_id_price_book_item_id_fk" FOREIGN KEY ("after_hours_item_id") REFERENCES "public"."price_book_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "after_hours_rate" ADD CONSTRAINT "after_hours_rate_holiday_item_id_price_book_item_id_fk" FOREIGN KEY ("holiday_item_id") REFERENCES "public"."price_book_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "after_hours_rate" ADD CONSTRAINT "after_hours_rate_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "after_hours_rate_org_idx" ON "after_hours_rate" USING btree ("organization_id");