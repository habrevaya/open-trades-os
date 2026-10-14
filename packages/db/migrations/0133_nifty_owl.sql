ALTER TYPE "public"."campaign_variant" ADD VALUE 'c';--> statement-breakpoint
ALTER TYPE "public"."campaign_variant" ADD VALUE 'd';--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_c_body" text;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_c_subject" text;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_d_body" text;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_d_subject" text;--> statement-breakpoint
ALTER TABLE "marketing_campaign" ADD COLUMN "variant_shares" integer[];