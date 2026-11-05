ALTER TYPE "public"."task_frequency" ADD VALUE 'yearly';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_second_email" (
	"membership_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"changed_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "assignee_on_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_template" ADD COLUMN "year_month" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_second_email" ADD CONSTRAINT "person_second_email_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_second_email" ADD CONSTRAINT "person_second_email_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_second_email" ADD CONSTRAINT "person_second_email_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
