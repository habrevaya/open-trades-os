CREATE TYPE "public"."geocode_precision" AS ENUM('rooftop', 'interpolated', 'street', 'postal_code', 'locality', 'placed');--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "latitude" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "longitude" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "location_source" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "location_precision" "geocode_precision";--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "located_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "located_address" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "address_key" text GENERATED ALWAYS AS (
    lower(btrim(regexp_replace(coalesce(address_line1, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(address_line2, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(city, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(state, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(postal_code, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(country, ''), '[[:space:]]+', ' ', 'g')))) STORED;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "geocode_attempted_address" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "geocode_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "geocode_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "geocode_error" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "location_source" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "location_precision" "geocode_precision";--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "located_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "located_address" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "address_key" text GENERATED ALWAYS AS (
    lower(btrim(regexp_replace(coalesce(address_line1, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(address_line2, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(city, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(state, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(postal_code, ''), '[[:space:]]+', ' ', 'g'))) || '|' ||
    lower(btrim(regexp_replace(coalesce(country, ''), '[[:space:]]+', ' ', 'g')))) STORED;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "geocode_attempted_address" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "geocode_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "geocode_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "geocode_error" text;