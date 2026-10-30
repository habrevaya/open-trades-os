DROP INDEX IF EXISTS "card_on_file_charge_autopay_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "payment_agreement_autopay_idx";--> statement-breakpoint
ALTER TABLE "card_on_file_charge" ADD COLUMN "card_rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "autopay_rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_on_file_charge_autopay_idx" ON "card_on_file_charge" USING btree ("organization_id","invoice_id","attempt","card_rank") WHERE "card_on_file_charge"."trigger" = 'autopay';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_agreement_autopay_idx" ON "payment_agreement" USING btree ("organization_id","customer_id","autopay_rank") WHERE "payment_agreement"."withdrawn_at" is null and "payment_agreement"."autopay_at" is not null;