ALTER TYPE "public"."task_frequency" ADD VALUE 'nth_weekday_of_month';--> statement-breakpoint
ALTER TYPE "public"."task_frequency" ADD VALUE 'every_n_weeks';--> statement-breakpoint
ALTER TYPE "public"."task_frequency" ADD VALUE 'chosen_weekdays';--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "month_week" integer;--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "interval_weeks" integer;--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "days_of_week" integer[];