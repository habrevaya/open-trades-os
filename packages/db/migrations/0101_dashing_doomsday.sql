CREATE TABLE IF NOT EXISTS "company_holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"repeats_yearly" boolean DEFAULT false NOT NULL,
	"closed" boolean DEFAULT true NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "skip_holidays" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_holiday" ADD CONSTRAINT "company_holiday_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_holiday_org_idx" ON "company_holiday" USING btree ("organization_id","date");