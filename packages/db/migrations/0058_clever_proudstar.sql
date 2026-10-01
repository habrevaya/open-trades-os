ALTER TYPE "public"."accounting_entity_kind" ADD VALUE 'refund';--> statement-breakpoint
ALTER TABLE "accounting_entity_link" ADD COLUMN "refunds_netted_at" timestamp with time zone;