ALTER TYPE "public"."task_frequency" ADD VALUE 'yearly';--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "year_month" integer;