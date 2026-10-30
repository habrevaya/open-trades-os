CREATE TABLE IF NOT EXISTS "mileage_rate_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid,
	"asset_id" uuid,
	"from_day" date NOT NULL,
	"per_mile" numeric(7, 3) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_rate_override_one_subject" CHECK (("mileage_rate_override"."technician_id" is null) <> ("mileage_rate_override"."asset_id" is null))
);
--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "lapse_reason_code" "agreement_cancellation_code";--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "lapse_reason" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_rate_source" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_asset_label" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mileage_rate_override" ADD CONSTRAINT "mileage_rate_override_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mileage_rate_override_person_day_idx" ON "mileage_rate_override" USING btree ("organization_id","technician_id","from_day") WHERE technician_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mileage_rate_override_asset_day_idx" ON "mileage_rate_override" USING btree ("organization_id","asset_id","from_day") WHERE asset_id is not null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense" ADD CONSTRAINT "expense_mileage_asset_id_company_asset_id_fk" FOREIGN KEY ("mileage_asset_id") REFERENCES "public"."company_asset"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_rate_source_known" CHECK ("expense"."mileage_rate_source" is null or "expense"."mileage_rate_source" in ('company', 'person', 'vehicle'));