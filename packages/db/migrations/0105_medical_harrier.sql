CREATE TYPE "public"."truck_fill_status" AS ENUM('open', 'confirmed', 'dismissed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('pending', 'approved', 'refused');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"promised_on" date,
	"previous_promised_on" date,
	"reference" text,
	"note" text,
	"recorded_by_user_id" uuid,
	"recorded_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "truck_fill_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"status" "truck_fill_status" DEFAULT 'open' NOT NULL,
	"proposed_on" date NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "truck_fill_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"on_truck" numeric(14, 4) NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"why" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cash_tip_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cash_tip_id" uuid NOT NULL,
	"previous_amount" numeric(14, 4) NOT NULL,
	"new_amount" numeric(14, 4) NOT NULL,
	"reason" text NOT NULL,
	"corrected_by_user_id" uuid,
	"corrected_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"job_id" uuid,
	"amount" numeric(14, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"spent_on" date NOT NULL,
	"description" text NOT NULL,
	"status" "expense_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "per_diem" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"day" date NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"recorded_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_export" ADD COLUMN "reimbursement_total" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "promised_on" date;--> statement-breakpoint
ALTER TABLE "cash_tip" ADD COLUMN "recorded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_tip" ADD COLUMN "recorded_by_name" text;--> statement-breakpoint
ALTER TABLE "tip_share" ADD COLUMN "split_rule" text DEFAULT 'even' NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_share" ADD COLUMN "split_note" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_acknowledgement" ADD CONSTRAINT "purchase_order_acknowledgement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_acknowledgement" ADD CONSTRAINT "purchase_order_acknowledgement_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_acknowledgement" ADD CONSTRAINT "purchase_order_acknowledgement_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_draft" ADD CONSTRAINT "truck_fill_draft_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_draft" ADD CONSTRAINT "truck_fill_draft_truck_id_location_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_draft_id_truck_fill_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."truck_fill_draft"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "truck_fill_line" ADD CONSTRAINT "truck_fill_line_from_location_id_location_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip_correction" ADD CONSTRAINT "cash_tip_correction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip_correction" ADD CONSTRAINT "cash_tip_correction_cash_tip_id_cash_tip_id_fk" FOREIGN KEY ("cash_tip_id") REFERENCES "public"."cash_tip"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip_correction" ADD CONSTRAINT "cash_tip_correction_corrected_by_user_id_user_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense" ADD CONSTRAINT "expense_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense" ADD CONSTRAINT "expense_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense" ADD CONSTRAINT "expense_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "per_diem" ADD CONSTRAINT "per_diem_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "per_diem" ADD CONSTRAINT "per_diem_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "per_diem" ADD CONSTRAINT "per_diem_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "per_diem" ADD CONSTRAINT "per_diem_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_acknowledgement_order_idx" ON "purchase_order_acknowledgement" USING btree ("organization_id","purchase_order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "truck_fill_draft_open_idx" ON "truck_fill_draft" USING btree ("organization_id","truck_id") WHERE "truck_fill_draft"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truck_fill_draft_truck_idx" ON "truck_fill_draft" USING btree ("organization_id","truck_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "truck_fill_line_draft_idx" ON "truck_fill_line" USING btree ("organization_id","draft_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_tip_correction_tip_idx" ON "cash_tip_correction" USING btree ("organization_id","cash_tip_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_person_idx" ON "expense" USING btree ("organization_id","technician_id","spent_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_status_idx" ON "expense" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_job_idx" ON "expense" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "per_diem_person_day_idx" ON "per_diem" USING btree ("organization_id","technician_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "per_diem_job_idx" ON "per_diem" USING btree ("organization_id","job_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip" ADD CONSTRAINT "cash_tip_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
