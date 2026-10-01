CREATE TYPE "public"."asset_compliance_kind" AS ENUM('registration', 'inspection', 'insurance', 'calibration');--> statement-breakpoint
CREATE TYPE "public"."asset_cost_kind" AS ENUM('acquisition', 'maintenance', 'fuel', 'repair', 'insurance', 'registration', 'storage', 'other');--> statement-breakpoint
CREATE TYPE "public"."asset_custodian_kind" AS ENUM('technician', 'location', 'job');--> statement-breakpoint
CREATE TYPE "public"."asset_interval_basis" AS ENUM('time', 'meter');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('vehicle', 'powered_tool', 'hand_tool', 'instrument', 'trailer', 'equipment');--> statement-breakpoint
CREATE TYPE "public"."asset_meter_unit" AS ENUM('hours', 'miles', 'kilometres', 'cycles');--> statement-breakpoint
CREATE TYPE "public"."asset_reading_source" AS ENUM('technician', 'telematics', 'invoice', 'import');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "asset_compliance_kind" NOT NULL,
	"expires_on" date NOT NULL,
	"reference" text,
	"last_certified_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_cost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "asset_cost_kind" NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"incurred_on" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_custody" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"custodian_kind" "asset_custodian_kind" NOT NULL,
	"custodian_id" uuid NOT NULL,
	"held_from" date NOT NULL,
	"held_until" date,
	"recorded_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_maintenance_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"label" text NOT NULL,
	"basis" "asset_interval_basis" NOT NULL,
	"model" "recurrence_model",
	"starts_on" date,
	"ends_on" date,
	"interval_days" integer,
	"anchor_months" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meter_unit" "asset_meter_unit",
	"every_units" integer,
	"last_serviced_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_meter_reading" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"unit" "asset_meter_unit" NOT NULL,
	"value" integer NOT NULL,
	"taken_on" date NOT NULL,
	"source" "asset_reading_source" NOT NULL,
	"reset_previous_final_value" integer,
	"reset_reason" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"label" text NOT NULL,
	"requirement_code" text,
	"identifier" text,
	"meter_unit" "asset_meter_unit",
	"meter_max_per_day" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"acquired_on" date,
	"retired_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_compliance" ADD CONSTRAINT "asset_compliance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_compliance" ADD CONSTRAINT "asset_compliance_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_cost" ADD CONSTRAINT "asset_cost_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_cost" ADD CONSTRAINT "asset_cost_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_custody" ADD CONSTRAINT "asset_custody_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_custody" ADD CONSTRAINT "asset_custody_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_custody" ADD CONSTRAINT "asset_custody_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_maintenance_plan" ADD CONSTRAINT "asset_maintenance_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_maintenance_plan" ADD CONSTRAINT "asset_maintenance_plan_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_meter_reading" ADD CONSTRAINT "asset_meter_reading_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_meter_reading" ADD CONSTRAINT "asset_meter_reading_asset_id_company_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."company_asset"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_meter_reading" ADD CONSTRAINT "asset_meter_reading_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_asset" ADD CONSTRAINT "company_asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_compliance_asset_idx" ON "asset_compliance" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_compliance_expiry_idx" ON "asset_compliance" USING btree ("organization_id","expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "asset_compliance_kind_idx" ON "asset_compliance" USING btree ("asset_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_cost_asset_idx" ON "asset_cost" USING btree ("organization_id","asset_id","incurred_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_custody_asset_idx" ON "asset_custody" USING btree ("organization_id","asset_id","held_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_custody_custodian_idx" ON "asset_custody" USING btree ("organization_id","custodian_kind","custodian_id","held_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_maintenance_plan_asset_idx" ON "asset_maintenance_plan" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_meter_reading_asset_idx" ON "asset_meter_reading" USING btree ("organization_id","asset_id","taken_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_asset_org_idx" ON "company_asset" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_asset_code_idx" ON "company_asset" USING btree ("organization_id","requirement_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_asset_identifier_idx" ON "company_asset" USING btree ("organization_id","identifier");