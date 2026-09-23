CREATE TABLE IF NOT EXISTS "recording_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"rule" text NOT NULL,
	"announcement_required" boolean DEFAULT true NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "recording_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "recording_refusal" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "announcement_played_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_segments" jsonb;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "transcript_redaction_counts" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recording_policy" ADD CONSTRAINT "recording_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recording_policy_jurisdiction_idx" ON "recording_policy" USING btree ("organization_id","jurisdiction") WHERE "recording_policy"."deleted_at" is null;