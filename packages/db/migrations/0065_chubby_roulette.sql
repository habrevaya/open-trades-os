CREATE TYPE "public"."delivery_frequency" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."delivery_kind" AS ENUM('report', 'statements');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "delivery_kind" NOT NULL,
	"name" text NOT NULL,
	"built_in_report" text,
	"report_id" uuid,
	"frequency" "delivery_frequency" NOT NULL,
	"weekdays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"day_of_month" integer,
	"time_of_day" text NOT NULL,
	"period" text DEFAULT 'all' NOT NULL,
	"recipient_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minimum_balance" numeric(14, 4),
	"owner_user_id" uuid,
	"paused_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_id" uuid,
	"workflow_run_id" uuid,
	"idempotency_key" text NOT NULL,
	"report_name" text NOT NULL,
	"built_in_report" text,
	"report_id" uuid,
	"period_from" date,
	"period_to" date,
	"status" text NOT NULL,
	"row_count" integer,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"ran_as_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statement_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"schedule_id" uuid,
	"period" text,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"destination" text,
	"closing_balance" numeric(14, 4),
	"message_id" uuid,
	"portal_grant_id" uuid,
	"error" text,
	"sent_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_schedule" ADD CONSTRAINT "delivery_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_schedule" ADD CONSTRAINT "delivery_schedule_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_schedule" ADD CONSTRAINT "delivery_schedule_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_delivery" ADD CONSTRAINT "report_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_delivery" ADD CONSTRAINT "report_delivery_schedule_id_delivery_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."delivery_schedule"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_delivery" ADD CONSTRAINT "report_delivery_ran_as_user_id_user_id_fk" FOREIGN KEY ("ran_as_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_schedule_id_delivery_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."delivery_schedule"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "statement_delivery" ADD CONSTRAINT "statement_delivery_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_attachment_message_idx" ON "message_attachment" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_schedule_due_idx" ON "delivery_schedule" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_schedule_org_idx" ON "delivery_schedule" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_schedule_statements_idx" ON "delivery_schedule" USING btree ("organization_id") WHERE "delivery_schedule"."kind" = 'statements';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_delivery_key_idx" ON "report_delivery" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_delivery_schedule_idx" ON "report_delivery" USING btree ("organization_id","schedule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statement_delivery_period_idx" ON "statement_delivery" USING btree ("organization_id","customer_id","period") WHERE "statement_delivery"."period" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_delivery_customer_idx" ON "statement_delivery" USING btree ("organization_id","customer_id","created_at");