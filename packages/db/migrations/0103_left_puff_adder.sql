CREATE TABLE IF NOT EXISTS "safety_talk_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"crew_id" uuid,
	"technician_id" uuid,
	"frequency" "task_frequency" NOT NULL,
	"weekday" integer,
	"month_day" integer,
	"held_minutes" integer DEFAULT 420 NOT NULL,
	"starts_on" date NOT NULL,
	"location" text,
	"led_by" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_raised_on" date,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "safety_talk_schedule_who" CHECK (("safety_talk_schedule"."crew_id" is null) <> ("safety_talk_schedule"."technician_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "safety_topic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safety_meeting" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_meeting" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_meeting" ADD COLUMN "occurrence_on" date;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_topic_id_safety_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."safety_topic"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_talk_schedule" ADD CONSTRAINT "safety_talk_schedule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_topic" ADD CONSTRAINT "safety_topic_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_topic" ADD CONSTRAINT "safety_topic_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_talk_schedule_org_idx" ON "safety_talk_schedule" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_topic_org_idx" ON "safety_topic" USING btree ("organization_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting" ADD CONSTRAINT "safety_meeting_topic_id_safety_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."safety_topic"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "safety_meeting" ADD CONSTRAINT "safety_meeting_schedule_id_safety_talk_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."safety_talk_schedule"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "safety_meeting_occurrence_idx" ON "safety_meeting" USING btree ("schedule_id","occurrence_on") WHERE schedule_id is not null;