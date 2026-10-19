ALTER TYPE "public"."staff_delivery_channel" ADD VALUE 'email';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "certification_renewals_keeper" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "person_certification" ADD COLUMN "renewal_lead_days" integer;--> statement-breakpoint
ALTER TABLE "staff_notice_setting" ADD COLUMN "email" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "certification_renewals_keeper" ADD CONSTRAINT "certification_renewals_keeper_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "certification_renewals_keeper" ADD CONSTRAINT "certification_renewals_keeper_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "certification_renewals_keeper_person_idx" ON "certification_renewals_keeper" USING btree ("organization_id","user_id");--> statement-breakpoint
-- The one person who kept the renewals list is kept, as the first of the people who now can. The old
-- column is no longer read, so it is emptied rather than left to say something different.
INSERT INTO "certification_renewals_keeper" ("organization_id", "user_id")
SELECT "id", "renewals_keeper_user_id" FROM "organization" WHERE "renewals_keeper_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "organization" SET "renewals_keeper_user_id" = NULL WHERE "renewals_keeper_user_id" IS NOT NULL;
