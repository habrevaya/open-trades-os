CREATE TABLE IF NOT EXISTS "warranty_maker" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registration_days" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "warranty_maker_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "warranty_maker" ADD CONSTRAINT "warranty_maker_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warranty_maker_name_idx" ON "warranty_maker" USING btree ("organization_id",lower("name")) WHERE "warranty_maker"."deleted_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item" ADD CONSTRAINT "price_book_item_warranty_maker_id_warranty_maker_id_fk" FOREIGN KEY ("warranty_maker_id") REFERENCES "public"."warranty_maker"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
