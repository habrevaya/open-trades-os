CREATE TABLE IF NOT EXISTS "customer_merge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kept_customer_id" uuid NOT NULL,
	"merged_customer_id" uuid NOT NULL,
	"merged_by_user_id" uuid,
	"reason" text,
	"moved" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filled" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags_added" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" uuid,
	"undo_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_kept_customer_id_customer_id_fk" FOREIGN KEY ("kept_customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_merged_customer_id_customer_id_fk" FOREIGN KEY ("merged_customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_merged_by_user_id_user_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_undone_by_user_id_user_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_merge_kept_idx" ON "customer_merge" USING btree ("organization_id","kept_customer_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_merge_merged_idx" ON "customer_merge" USING btree ("merged_customer_id");