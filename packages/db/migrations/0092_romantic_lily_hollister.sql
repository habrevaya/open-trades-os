ALTER TABLE "delivery_schedule" ADD COLUMN "text_when_preferred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_delivery" ADD COLUMN "note" text;