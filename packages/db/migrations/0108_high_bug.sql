CREATE TYPE "public"."continuing_education_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "status" "continuing_education_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "self_logged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "decided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "continuing_education" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "technician_skill" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "technician_skill" ADD COLUMN "renewal_lead_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "continuing_education" ADD CONSTRAINT "continuing_education_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
