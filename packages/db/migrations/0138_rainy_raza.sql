CREATE TYPE "public"."route_day_status" AS ENUM('counted', 'gap', 'no_route');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"day" date NOT NULL,
	"stops" integer NOT NULL,
	"drives" integer NOT NULL,
	"miles" numeric(10, 3) NOT NULL,
	"fixes" integer NOT NULL,
	"status" "route_day_status" NOT NULL,
	"note" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_day" ADD CONSTRAINT "route_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_day" ADD CONSTRAINT "route_day_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_day_person_day_idx" ON "route_day" USING btree ("technician_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_day_day_idx" ON "route_day" USING btree ("organization_id","day");