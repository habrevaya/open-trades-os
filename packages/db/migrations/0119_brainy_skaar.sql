ALTER TABLE "app_plugin" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_plugin" ADD COLUMN "disabled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app_plugin" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_plugin" ADD CONSTRAINT "app_plugin_disabled_by_user_id_user_id_fk" FOREIGN KEY ("disabled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
