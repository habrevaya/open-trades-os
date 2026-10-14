ALTER TABLE "organization" ADD COLUMN "renewals_keeper_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization" ADD CONSTRAINT "organization_renewals_keeper_user_id_user_id_fk" FOREIGN KEY ("renewals_keeper_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
