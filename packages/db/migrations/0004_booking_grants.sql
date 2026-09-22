ALTER TYPE "public"."portal_grant_scope" ADD VALUE 'booking';--> statement-breakpoint
ALTER TABLE "portal_grant" ALTER COLUMN "customer_id" DROP NOT NULL;