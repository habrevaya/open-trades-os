CREATE TABLE IF NOT EXISTS "truck_water_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"on_day" date NOT NULL,
	"gallons" numeric(14, 4) NOT NULL,
	"source" text NOT NULL,
	"technician_id" uuid,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "street_source" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "street_for_address" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "street_attempted_address" text;--> statement-breakpoint
ALTER TABLE "job_line" ADD COLUMN "rental_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "rental_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_water_day" ADD CONSTRAINT "truck_water_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_water_day" ADD CONSTRAINT "truck_water_day_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_water_day" ADD CONSTRAINT "truck_water_day_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_water_day_idx" ON "truck_water_day" USING btree ("organization_id","asset_id","on_day");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_line" ADD CONSTRAINT "job_line_rental_id_rental_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rental"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_rental_id_rental_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rental"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
