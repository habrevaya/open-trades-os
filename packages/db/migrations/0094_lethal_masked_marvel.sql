ALTER TABLE "rate_card" ADD COLUMN "escalated_from_id" uuid;--> statement-breakpoint
ALTER TABLE "rate_card" ADD COLUMN "escalation_rate" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "service_contract" ADD COLUMN "escalated_through" date;