ALTER TABLE "staff_notice_digest" ADD COLUMN "hour" integer;--> statement-breakpoint
ALTER TABLE "staff_notice_setting" ADD COLUMN "chosen" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Data backfill, written by hand: a row the company's defaults copied onto a
-- person when they joined was inserted by the membership trigger in the same
-- transaction as the membership (so the same created_at) and has not been
-- saved since (updated_at still equals created_at). Those are the company's,
-- not the person's own choice. Every other row stays a choice of the person's.
UPDATE "staff_notice_setting" s SET "chosen" = false
 WHERE s."updated_at" = s."created_at"
   AND EXISTS (
     SELECT 1 FROM "membership" m
      WHERE m."organization_id" = s."organization_id"
        AND m."user_id" = s."user_id"
        AND m."created_at" = s."created_at"
   );
