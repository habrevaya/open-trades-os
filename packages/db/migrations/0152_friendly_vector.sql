CREATE TYPE "public"."visit_cancel_reason" AS ENUM('weather', 'crew_short', 'equipment', 'other');--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "cancel_reason" "visit_cancel_reason";--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "cancel_reason_note" text;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_cancel_reason_company" CHECK ("visit"."cancel_reason" is null or "visit"."cancelled_by" = 'company');--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_cancel_reason_says_what" CHECK (("visit"."cancel_reason_note" is null or "visit"."cancel_reason" is not null)
      and ("visit"."cancel_reason" is distinct from 'other' or ("visit"."cancel_reason_note" is not null and btrim("visit"."cancel_reason_note") <> '')));