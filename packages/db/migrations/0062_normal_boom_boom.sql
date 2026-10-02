CREATE TYPE "public"."credit_note_status" AS ENUM('draft', 'open', 'partially_applied', 'applied', 'void');--> statement-breakpoint
CREATE TYPE "public"."credit_reason" AS ENUM('billing_error', 'price_adjustment', 'goodwill', 'work_not_done', 'duplicate_invoice', 'contract_adjustment');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid,
	"status" "credit_note_status" DEFAULT 'draft' NOT NULL,
	"reason" "credit_reason" NOT NULL,
	"note" text,
	"issued_on" date,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"subtotal" numeric(14, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"amount_applied" numeric(14, 4) DEFAULT '0' NOT NULL,
	"balance" numeric(14, 4) DEFAULT '0' NOT NULL,
	"issued_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_note_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"applied_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_note_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_line_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) DEFAULT '0' NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"tax_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "amount_credited" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_issued_by_user_id_user_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_application" ADD CONSTRAINT "credit_note_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_application" ADD CONSTRAINT "credit_note_application_credit_note_id_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_note"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_application" ADD CONSTRAINT "credit_note_application_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_credit_note_id_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_note"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_invoice_line_id_invoice_line_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_line"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_note_source_ref_idx" ON "credit_note" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_note_number_idx" ON "credit_note" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_customer_idx" ON "credit_note" USING btree ("organization_id","customer_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_invoice_idx" ON "credit_note" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_application_note_idx" ON "credit_note_application" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_application_invoice_idx" ON "credit_note_application" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_line_note_idx" ON "credit_note_line" USING btree ("credit_note_id");