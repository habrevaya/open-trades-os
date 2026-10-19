CREATE TYPE "public"."review_kind" AS ENUM('stars', 'recommendation');--> statement-breakpoint
ALTER TABLE "review" ALTER COLUMN "rating" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "kind" "review_kind" DEFAULT 'stars' NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "recommends" boolean;--> statement-breakpoint
-- A Facebook recommendation that was read as five or one stars is a recommendation again. Only where the
-- source says so: read from a Facebook Page connection, with no words of the person's own, so the review says
-- what Facebook's yes or no was turned into. One with words in it cannot be told from an old star rating here;
-- the next hourly read of the Page converts it, since Facebook says which it is.
UPDATE "review" r SET "kind" = 'recommendation', "recommends" = (r."body" = 'Recommends you on Facebook.'), "rating" = NULL
 WHERE r."connection_id" IN (SELECT c."id" FROM "integration_connection" c WHERE c."provider" = 'facebook_page')
   AND r."body" IN ('Recommends you on Facebook.', 'Does not recommend you on Facebook.');--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_kind_fields" CHECK ((
    "review"."kind" = 'stars' and "review"."rating" is not null and "review"."rating" between 1 and 5 and "review"."recommends" is null
  ) or (
    "review"."kind" = 'recommendation' and "review"."rating" is null and "review"."recommends" is not null
  ));