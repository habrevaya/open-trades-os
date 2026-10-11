CREATE TYPE "public"."rental_invoice_mode" AS ENUM('per_haul', 'chain');--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "invoice_as" "rental_invoice_mode" DEFAULT 'per_haul' NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_pass_through" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_passed_on" boolean;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_amount" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_fee_decided_by_user_id" uuid;