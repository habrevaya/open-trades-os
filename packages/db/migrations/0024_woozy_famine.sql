CREATE TYPE "public"."day_attribution" AS ENUM('shift_start', 'split_at_midnight');--> statement-breakpoint
CREATE TYPE "public"."on_call_treatment" AS ENUM('separate_rate_not_hours_worked', 'hours_worked_at_base');--> statement-breakpoint
CREATE TYPE "public"."rounding_direction" AS ENUM('nearest', 'up', 'down');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "overtime_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"time_zone" text NOT NULL,
	"week_starts_on" integer NOT NULL,
	"day_attribution" "day_attribution" NOT NULL,
	"weekly_threshold_minutes" integer,
	"weekly_double_time_threshold_minutes" integer,
	"daily_threshold_minutes" integer,
	"daily_double_time_threshold_minutes" integer,
	"overtime_multiplier" numeric(9, 6) NOT NULL,
	"double_time_multiplier" numeric(9, 6) NOT NULL,
	"on_call_treatment" "on_call_treatment" NOT NULL,
	"rounding_minutes" integer,
	"rounding_direction" "rounding_direction",
	"counts_toward_overtime" jsonb,
	"note" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "technician" ADD COLUMN "wage_classification" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "overtime_policy" ADD CONSTRAINT "overtime_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "overtime_policy_active_idx" ON "overtime_policy" USING btree ("organization_id") WHERE "overtime_policy"."active" and "overtime_policy"."deleted_at" is null;