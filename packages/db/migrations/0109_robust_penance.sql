CREATE TYPE "public"."campaign_variant" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TYPE "public"."review_request_source" AS ENUM('office', 'automation');--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD COLUMN "variant" "campaign_variant" DEFAULT 'a' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_b_body" text;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_b_subject" text;--> statement-breakpoint
ALTER TABLE "review_request" ADD COLUMN "source" "review_request_source" DEFAULT 'office' NOT NULL;