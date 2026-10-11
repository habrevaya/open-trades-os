CREATE TYPE "public"."disposal_fee_basis" AS ENUM('per_ton', 'per_load');--> statement-breakpoint
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
ALTER TABLE "rental" ADD COLUMN "disposal_facility_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disposal_facility" ADD CONSTRAINT "disposal_facility_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disposal_facility_org_idx" ON "disposal_facility" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "disposal_facility_default_idx" ON "disposal_facility" USING btree ("organization_id") WHERE "disposal_facility"."is_default" and "disposal_facility"."active";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental" ADD CONSTRAINT "rental_disposal_facility_id_disposal_facility_id_fk" FOREIGN KEY ("disposal_facility_id") REFERENCES "public"."disposal_facility"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
