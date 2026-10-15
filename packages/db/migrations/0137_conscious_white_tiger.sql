CREATE TYPE "public"."job_hold_reason" AS ENUM('part', 'inspection', 'customer', 'weather', 'other');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"reason" "job_hold_reason" NOT NULL,
	"purchase_order_id" uuid,
	"note" text,
	"status_before" "job_status" NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"placed_by_user_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "multi_visit_planned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "multi_visit_planned_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold" ADD CONSTRAINT "job_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold" ADD CONSTRAINT "job_hold_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold" ADD CONSTRAINT "job_hold_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold" ADD CONSTRAINT "job_hold_placed_by_user_id_user_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_hold" ADD CONSTRAINT "job_hold_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_hold_job_idx" ON "job_hold" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_hold_open_idx" ON "job_hold" USING btree ("job_id") WHERE "job_hold"."released_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_hold_order_idx" ON "job_hold" USING btree ("purchase_order_id") WHERE "job_hold"."purchase_order_id" is not null;