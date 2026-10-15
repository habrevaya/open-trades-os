CREATE TYPE "public"."visit_cancelled_by" AS ENUM('customer', 'company');--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "cancel_notice_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "cancelled_by" "visit_cancelled_by";--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "cancel_notice_hours" integer;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_cancel_says_when" CHECK ("visit"."cancelled_by" is null or ("visit"."cancelled_at" is not null and "visit"."cancel_notice_hours" is not null));