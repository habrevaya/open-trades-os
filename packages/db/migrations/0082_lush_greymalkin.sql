CREATE TYPE "public"."employment_type" AS ENUM('full_time', 'part_time', 'seasonal', 'temporary', 'contractor');--> statement-breakpoint
CREATE TYPE "public"."onboarding_item_kind" AS ENUM('document', 'training', 'equipment', 'other');--> statement-breakpoint
CREATE TYPE "public"."pay_type" AS ENUM('hourly', 'salary', 'piece_rate', 'commission_only');--> statement-breakpoint
CREATE TYPE "public"."purchase_approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."landed_cost_basis" AS ENUM('value', 'quantity');--> statement-breakpoint
CREATE TYPE "public"."stock_tracking_mode" AS ENUM('serial', 'lot');--> statement-breakpoint
CREATE TYPE "public"."rental_charge_kind" AS ENUM('contamination', 'prohibited_item', 'overweight', 'overfill', 'other');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "continuing_education" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"certification_type_id" uuid NOT NULL,
	"completed_on" date NOT NULL,
	"hours" numeric(7, 2) NOT NULL,
	"course" text NOT NULL,
	"provider" text,
	"evidence" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "emergency_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" text,
	"phone" text NOT NULL,
	"alternate_phone" text,
	"note" text,
	"priority" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employment_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"job_title" text,
	"started_on" date NOT NULL,
	"ended_on" date,
	"employment_type" "employment_type" NOT NULL,
	"pay_type" "pay_type" NOT NULL,
	"payroll_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"template_item_id" uuid,
	"kind" "onboarding_item_kind" NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"note" text,
	"company_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_template_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" "member_role",
	"role_id" uuid,
	"kind" "onboarding_item_kind" NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technician_skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"since" date NOT NULL,
	"evidence" text NOT NULL,
	"recorded_by_user_id" uuid,
	"ended_on" date,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_approval_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"minimum_total" numeric(14, 4) NOT NULL,
	"approver_role" "member_role",
	"approver_role_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"rule_id" uuid,
	"step" integer NOT NULL,
	"minimum_total" numeric(14, 4) NOT NULL,
	"role_label" text NOT NULL,
	"order_total" numeric(14, 4) NOT NULL,
	"decision" "purchase_approval_decision" NOT NULL,
	"decided_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"received_by_user_id" uuid,
	"basis" "landed_cost_basis" DEFAULT 'value' NOT NULL,
	"charges_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_receipt_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"destination" text,
	"state" text NOT NULL,
	"explanation" text,
	"message_id" uuid,
	"link_token_hash" text,
	"link_expires_at" timestamp with time zone,
	"sent_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"mode" "stock_tracking_mode" NOT NULL,
	"number" text NOT NULL,
	"expires_on" date,
	"equipment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_tracking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"mode" "stock_tracking_mode" NOT NULL,
	"set_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "truck_stock_minimum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"minimum" numeric(14, 4) NOT NULL,
	"target" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rental_id" uuid NOT NULL,
	"kind" "rental_charge_kind" NOT NULL,
	"description" text NOT NULL,
	"price_book_item_id" uuid,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid,
	"invoice_id" uuid,
	"invoiced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "collection_visit_id" uuid;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_type" ADD COLUMN "ce_hours_required" numeric(7, 2);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "landed_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "continuing_education" ADD CONSTRAINT "continuing_education_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "continuing_education" ADD CONSTRAINT "continuing_education_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "continuing_education" ADD CONSTRAINT "continuing_education_certification_type_id_certification_type_id_fk" FOREIGN KEY ("certification_type_id") REFERENCES "public"."certification_type"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "continuing_education" ADD CONSTRAINT "continuing_education_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employment_record" ADD CONSTRAINT "employment_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employment_record" ADD CONSTRAINT "employment_record_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_template_item_id_onboarding_template_item_id_fk" FOREIGN KEY ("template_item_id") REFERENCES "public"."onboarding_template_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_done_by_user_id_user_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_item" ADD CONSTRAINT "onboarding_item_company_asset_id_company_asset_id_fk" FOREIGN KEY ("company_asset_id") REFERENCES "public"."company_asset"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_template_item" ADD CONSTRAINT "onboarding_template_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_template_item" ADD CONSTRAINT "onboarding_template_item_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician_skill" ADD CONSTRAINT "technician_skill_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician_skill" ADD CONSTRAINT "technician_skill_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician_skill" ADD CONSTRAINT "technician_skill_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_approval_rule" ADD CONSTRAINT "purchase_approval_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_approval_rule" ADD CONSTRAINT "purchase_approval_rule_approver_role_id_role_id_fk" FOREIGN KEY ("approver_role_id") REFERENCES "public"."role"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_approval_rule" ADD CONSTRAINT "purchase_approval_rule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval" ADD CONSTRAINT "purchase_order_approval_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval" ADD CONSTRAINT "purchase_order_approval_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval" ADD CONSTRAINT "purchase_order_approval_rule_id_purchase_approval_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."purchase_approval_rule"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_approval" ADD CONSTRAINT "purchase_order_approval_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_receipt" ADD CONSTRAINT "purchase_order_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_receipt" ADD CONSTRAINT "purchase_order_receipt_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_receipt" ADD CONSTRAINT "purchase_order_receipt_received_by_user_id_user_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_receipt_charge" ADD CONSTRAINT "purchase_order_receipt_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_receipt_charge" ADD CONSTRAINT "purchase_order_receipt_charge_receipt_id_purchase_order_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_order_receipt"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_send" ADD CONSTRAINT "purchase_order_send_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_send" ADD CONSTRAINT "purchase_order_send_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_send" ADD CONSTRAINT "purchase_order_send_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_tracking" ADD CONSTRAINT "stock_tracking_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_tracking" ADD CONSTRAINT "stock_tracking_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_tracking" ADD CONSTRAINT "stock_tracking_set_by_user_id_user_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_stock_minimum" ADD CONSTRAINT "truck_stock_minimum_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_stock_minimum" ADD CONSTRAINT "truck_stock_minimum_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_stock_minimum" ADD CONSTRAINT "truck_stock_minimum_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_charge" ADD CONSTRAINT "rental_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_charge" ADD CONSTRAINT "rental_charge_rental_id_rental_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rental"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_charge" ADD CONSTRAINT "rental_charge_price_book_item_id_price_book_item_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental_charge" ADD CONSTRAINT "rental_charge_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "continuing_education_person_idx" ON "continuing_education" USING btree ("organization_id","technician_id","certification_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "emergency_contact_person_idx" ON "emergency_contact" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employment_record_person_idx" ON "employment_record" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_item_person_idx" ON "onboarding_item" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_item_template_idx" ON "onboarding_item" USING btree ("membership_id","template_item_id") WHERE "onboarding_item"."template_item_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_template_item_role_idx" ON "onboarding_template_item" USING btree ("organization_id","role","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "technician_skill_open_idx" ON "technician_skill" USING btree ("technician_id","skill") WHERE "technician_skill"."ended_on" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_approval_rule_step_idx" ON "purchase_approval_rule" USING btree ("organization_id","step") WHERE "purchase_approval_rule"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_approval_step_idx" ON "purchase_order_approval" USING btree ("purchase_order_id","step");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_receipt_order_idx" ON "purchase_order_receipt" USING btree ("purchase_order_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_receipt_charge_receipt_idx" ON "purchase_order_receipt_charge" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_send_order_idx" ON "purchase_order_send" USING btree ("purchase_order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_send_token_idx" ON "purchase_order_send" USING btree ("link_token_hash") WHERE "purchase_order_send"."link_token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_lot_number_idx" ON "stock_lot" USING btree ("organization_id","item_id",lower("number"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_lot_equipment_idx" ON "stock_lot" USING btree ("organization_id","equipment_id") WHERE "stock_lot"."equipment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_tracking_item_idx" ON "stock_tracking" USING btree ("organization_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_stock_minimum_item_location_idx" ON "truck_stock_minimum" USING btree ("organization_id","item_id","location_id") WHERE "truck_stock_minimum"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_charge_rental_idx" ON "rental_charge" USING btree ("organization_id","rental_id") WHERE "rental_charge"."deleted_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_lot_id_stock_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lot"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_receipt_id_purchase_order_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_order_receipt"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movement_lot_idx" ON "stock_movement" USING btree ("organization_id","lot_id") WHERE "stock_movement"."lot_id" is not null;