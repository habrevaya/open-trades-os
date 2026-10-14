CREATE TABLE IF NOT EXISTS "customer_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"body" text NOT NULL,
	"noted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_user_id" uuid,
	"origin" text DEFAULT 'typed' NOT NULL,
	"pinned_at" timestamp with time zone,
	"pinned_by_user_id" uuid,
	"for_field" boolean DEFAULT false NOT NULL,
	"corrects_note_id" uuid,
	"edited_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_note" ADD CONSTRAINT "customer_note_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_note" ADD CONSTRAINT "customer_note_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_note" ADD CONSTRAINT "customer_note_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_note" ADD CONSTRAINT "customer_note_pinned_by_user_id_user_id_fk" FOREIGN KEY ("pinned_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_note" ADD CONSTRAINT "customer_note_corrects_note_id_customer_note_id_fk" FOREIGN KEY ("corrects_note_id") REFERENCES "public"."customer_note"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_note_customer_idx" ON "customer_note" USING btree ("customer_id","noted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_note_org_idx" ON "customer_note" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_note_source_ref_idx" ON "customer_note" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
-- The old notes box, carried into each customer's first note. Nothing read `customer.notes`,
-- so what was typed there is moved rather than copied: the note is dated when the customer
-- was last changed, the nearest thing to when it was written that the row holds, marked
-- `carried` with no author, and the box is emptied so it is never carried twice.
INSERT INTO "customer_note" ("organization_id", "customer_id", "body", "noted_at", "origin", "created_at", "updated_at")
SELECT c."organization_id", c."id", btrim(c."notes"), c."updated_at", 'carried', now(), now()
FROM "customer" c
WHERE c."notes" IS NOT NULL AND btrim(c."notes") <> '';--> statement-breakpoint
UPDATE "customer" SET "notes" = NULL WHERE "notes" IS NOT NULL;
