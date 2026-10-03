CREATE TYPE "public"."position_reason" AS ENUM('on_the_way', 'working', 'on_the_clock');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technician_position" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_meters" integer,
	"heading" integer,
	"speed" double precision,
	"reason" "position_reason" NOT NULL,
	"visit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "travel_time" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"origin_key" text NOT NULL,
	"destination_key" text NOT NULL,
	"minutes" integer NOT NULL,
	"meters" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "technician" ADD COLUMN "workday" jsonb;--> statement-breakpoint
ALTER TABLE "technician" ADD COLUMN "share_location" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "technician" ADD COLUMN "photo_file_id" uuid;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "dispatch_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician_position" ADD CONSTRAINT "technician_position_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician_position" ADD CONSTRAINT "technician_position_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician_position" ADD CONSTRAINT "technician_position_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "travel_time" ADD CONSTRAINT "travel_time_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "technician_position_fix_idx" ON "technician_position" USING btree ("device_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technician_position_latest_idx" ON "technician_position" USING btree ("organization_id","technician_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technician_position_visit_idx" ON "technician_position" USING btree ("visit_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technician_position_purge_idx" ON "technician_position" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "travel_time_pair_idx" ON "travel_time" USING btree ("organization_id","provider","origin_key","destination_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "travel_time_expires_idx" ON "travel_time" USING btree ("expires_at");