CREATE TYPE "public"."container_hold_kind" AS ENUM('repair', 'customer');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "container_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "container_hold_kind" NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"reason" text NOT NULL,
	"customer_id" uuid,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "delivered_time_known" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "tipped_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_hold" ADD CONSTRAINT "container_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_hold" ADD CONSTRAINT "container_hold_asset_id_rentable_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."rentable_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_hold" ADD CONSTRAINT "container_hold_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_hold" ADD CONSTRAINT "container_hold_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_hold_asset_idx" ON "container_hold" USING btree ("organization_id","asset_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "container_hold_open_idx" ON "container_hold" USING btree ("asset_id","kind") WHERE "container_hold"."ends_at" is null;--> statement-breakpoint
-- A can tagged out before repairs were kept as periods has a repair running and no start:
-- the status said it was out, and nothing said since when. It is opened here with no start,
-- which the turnaround reads as having begun before anything it measures, rather than dated
-- to this migration, which would be a guess. Putting the can back in service closes it.
INSERT INTO "container_hold" ("organization_id", "asset_id", "kind", "starts_at", "reason", "created_at", "updated_at")
SELECT ra."organization_id", ra."id", 'repair', NULL, 'Tagged out before repair history was kept', now(), now()
FROM "rentable_asset" ra
WHERE ra."status" = 'out_of_service' AND ra."deleted_at" IS NULL;
