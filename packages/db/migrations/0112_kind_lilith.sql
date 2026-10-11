CREATE TYPE "public"."disposal_fee_basis" AS ENUM('per_ton', 'per_load');--> statement-breakpoint
CREATE TYPE "public"."rental_invoice_mode" AS ENUM('per_haul', 'chain');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disposal_facility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"latitude" text,
	"longitude" text,
	"location_source" text,
	"location_precision" "geocode_precision",
	"located_at" timestamp with time zone,
	"located_address" text,
	"address_key" text GENERATED ALWAYS AS (
    lower(btrim(regexp_replace(coalesce(address_line1, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(address_line2, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(city, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(state, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(postal_code, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(country, ''), '[[:space:]]+', ' ', 'g')))) STORED,
	"geocode_attempted_address" text,
	"geocode_attempts" integer DEFAULT 0 NOT NULL,
	"geocode_retry_at" timestamp with time zone,
	"geocode_error" text,
	"hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fee_basis" "disposal_fee_basis",
	"fee_amount" numeric(14, 4),
	"minimum_fee" numeric(14, 4),
	"tip_minutes" integer DEFAULT 20 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
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
ALTER TABLE "rental" ADD COLUMN "disposal_facility_id" uuid;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "invoice_as" "rental_invoice_mode" DEFAULT 'per_haul' NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_pass_through" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_passed_on" boolean;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_amount" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_decided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "company_asset" ADD COLUMN "truck_kind_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disposal_facility" ADD CONSTRAINT "disposal_facility_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_kind" ADD CONSTRAINT "truck_kind_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disposal_facility_org_idx" ON "disposal_facility" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "disposal_facility_default_idx" ON "disposal_facility" USING btree ("organization_id") WHERE "disposal_facility"."is_default" and "disposal_facility"."active";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_kind_name_idx" ON "truck_kind" USING btree ("organization_id","name") WHERE "truck_kind"."deleted_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental" ADD CONSTRAINT "rental_disposal_facility_id_disposal_facility_id_fk" FOREIGN KEY ("disposal_facility_id") REFERENCES "public"."disposal_facility"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_asset" ADD CONSTRAINT "company_asset_truck_kind_id_truck_kind_id_fk" FOREIGN KEY ("truck_kind_id") REFERENCES "public"."truck_kind"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
