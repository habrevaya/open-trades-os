ALTER TYPE "public"."webhook_replay_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "connected_app" ADD COLUMN "requested_permissions" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "previous_secret_hash" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "previous_secret_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "secret_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_replay" ADD COLUMN "cancelled_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_replay" ADD CONSTRAINT "webhook_replay_cancelled_by_user_id_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connected_app_claim_idx" ON "connected_app" USING btree ("organization_id","claim_hash");