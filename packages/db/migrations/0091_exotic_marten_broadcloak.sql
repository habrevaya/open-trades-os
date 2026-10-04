CREATE TABLE IF NOT EXISTS "customer_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"tag" text NOT NULL,
	"tag_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "token_endpoint_auth_method" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "secret_hash" text;--> statement-breakpoint
ALTER TABLE "trade_pack_application" ADD COLUMN "seeded_setup" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_tag_slot_idx" ON "customer_tag" USING btree ("customer_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_tag_key_idx" ON "customer_tag" USING btree ("organization_id","tag_key","customer_id");--> statement-breakpoint
-- customer_tag backfill. Every tag every live customer carries, one row each, in the order
-- its list holds them and spelled exactly as stored, with the key core/tags compares by:
-- trimmed, inner spaces run together, lower cased. A null in a list is not a tag and is left
-- out. From here on the trigger in sql/after.sql keeps the table equal to the lists.
INSERT INTO "customer_tag" ("organization_id", "customer_id", "position", "tag", "tag_key")
SELECT c."organization_id", c."id", (t.ord - 1)::int, t.tag,
       lower(regexp_replace(regexp_replace(t.tag, '\s+', ' ', 'g'), '^ | $', '', 'g'))
FROM "customer" c
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(c."tags") = 'array' THEN c."tags" ELSE '[]'::jsonb END
) WITH ORDINALITY AS t(tag, ord)
WHERE c."deleted_at" IS NULL AND t.tag IS NOT NULL;
