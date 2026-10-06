CREATE TABLE IF NOT EXISTS "tax_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_rate_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"effective_from" date NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"charges_tax" boolean DEFAULT true NOT NULL,
	"default_tax_rate_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "tax_exempt_expires_on" date;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "price_book_category" ADD COLUMN "taxable" boolean;--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "tax_source" text;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "tax_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "tax_source" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_rate_version" ADD CONSTRAINT "tax_rate_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_rate_version" ADD CONSTRAINT "tax_rate_version_tax_rate_id_tax_rate_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_rate_version" ADD CONSTRAINT "tax_rate_version_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_setting" ADD CONSTRAINT "tax_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tax_setting" ADD CONSTRAINT "tax_setting_default_tax_rate_id_tax_rate_id_fk" FOREIGN KEY ("default_tax_rate_id") REFERENCES "public"."tax_rate"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_rate_name_idx" ON "tax_rate" USING btree ("organization_id",lower("name")) WHERE "tax_rate"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_rate_version_day_idx" ON "tax_rate_version" USING btree ("tax_rate_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_rate_version_org_idx" ON "tax_rate_version" USING btree ("organization_id","tax_rate_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_setting_org_idx" ON "tax_setting" USING btree ("organization_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer" ADD CONSTRAINT "customer_tax_rate_id_tax_rate_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rate"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property" ADD CONSTRAINT "property_tax_rate_id_tax_rate_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rate"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_line" ADD CONSTRAINT "estimate_line_tax_rate_id_tax_rate_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rate"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_tax_rate_id_tax_rate_id_fk" FOREIGN KEY ("tax_rate_id") REFERENCES "public"."tax_rate"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
