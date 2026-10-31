CREATE TABLE IF NOT EXISTS "client_work_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"job_type_id" uuid,
	"price_book_item_id" uuid,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_line" ADD COLUMN "client_code" text;--> statement-breakpoint
ALTER TABLE "external_work_order" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "external_work_order" ADD COLUMN "client_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_work_code" ADD CONSTRAINT "client_work_code_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_work_code" ADD CONSTRAINT "client_work_code_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_work_code" ADD CONSTRAINT "client_work_code_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_work_code" ADD CONSTRAINT "client_work_code_price_book_item_id_price_book_item_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_item"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_work_code_code_idx" ON "client_work_code" USING btree ("organization_id","customer_id",lower("code"));--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_work_order" ADD CONSTRAINT "external_work_order_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
