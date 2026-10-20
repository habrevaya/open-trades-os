CREATE TABLE IF NOT EXISTS "do_not_mail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid,
	"name" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"building" text,
	"unit" text DEFAULT '' NOT NULL,
	"reason" text,
	"added_by_user_id" uuid,
	"removed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "quantity_is_crew_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "budget_estimate_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate_line" ADD COLUMN "quantity_is_crew_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_reward" ADD COLUMN "auto_applied_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "do_not_mail" ADD CONSTRAINT "do_not_mail_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "do_not_mail" ADD CONSTRAINT "do_not_mail_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "do_not_mail" ADD CONSTRAINT "do_not_mail_added_by_user_id_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "do_not_mail" ADD CONSTRAINT "do_not_mail_removed_by_user_id_user_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "do_not_mail_customer_idx" ON "do_not_mail" USING btree ("organization_id","customer_id") WHERE "do_not_mail"."deleted_at" is null and "do_not_mail"."customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "do_not_mail_address_idx" ON "do_not_mail" USING btree ("organization_id","building","unit") WHERE "do_not_mail"."deleted_at" is null and "do_not_mail"."customer_id" is null and "do_not_mail"."building" is not null;