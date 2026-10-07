CREATE TABLE IF NOT EXISTS "truck_kind" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"containers_carried" integer NOT NULL,
	"container_sizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"yard_minutes" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_asset" ADD COLUMN "truck_kind_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_kind" ADD CONSTRAINT "truck_kind_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_kind_name_idx" ON "truck_kind" USING btree ("organization_id","name") WHERE "truck_kind"."deleted_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_asset" ADD CONSTRAINT "company_asset_truck_kind_id_truck_kind_id_fk" FOREIGN KEY ("truck_kind_id") REFERENCES "public"."truck_kind"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
