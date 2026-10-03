CREATE TYPE "public"."visit_change_kind" AS ENUM('reschedule', 'cancel');--> statement-breakpoint
CREATE TYPE "public"."visit_change_status" AS ENUM('pending', 'approved', 'declined', 'superseded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visit_change_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "visit_change_kind" NOT NULL,
	"status" "visit_change_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"bookable_service_id" uuid,
	"requested_date" date,
	"arrival_window_id" uuid,
	"requested_start" timestamp with time zone,
	"requested_end" timestamp with time zone,
	"previous_start" timestamp with time zone,
	"previous_end" timestamp with time zone,
	"task_id" uuid,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"response" text,
	"notified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "member_agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "member_discount_amount" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "member_agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "member_discount_amount" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "renewal_notice_outcome" text;--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "last_renewed_on" date;--> statement-breakpoint
ALTER TABLE "agreement_billing" ADD COLUMN "term" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_visit" ADD COLUMN "term" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "template_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_bookable_service_id_bookable_service_id_fk" FOREIGN KEY ("bookable_service_id") REFERENCES "public"."bookable_service"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_arrival_window_id_arrival_window_id_fk" FOREIGN KEY ("arrival_window_id") REFERENCES "public"."arrival_window"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_change_request" ADD CONSTRAINT "visit_change_request_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "visit_change_request_pending_idx" ON "visit_change_request" USING btree ("visit_id") WHERE "visit_change_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_change_request_org_idx" ON "visit_change_request" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_change_request_job_idx" ON "visit_change_request" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_template_idx" ON "workflow" USING btree ("organization_id","template_key") WHERE "workflow"."template_key" is not null and "workflow"."deleted_at" is null;