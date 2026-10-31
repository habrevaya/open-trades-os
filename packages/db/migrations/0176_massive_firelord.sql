ALTER TYPE "public"."portal_grant_scope" ADD VALUE 'statement';--> statement-breakpoint
ALTER TABLE "statement_delivery_copy" ADD COLUMN "portal_grant_id" uuid;