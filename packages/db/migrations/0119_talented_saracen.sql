CREATE TABLE IF NOT EXISTS "queue_callback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid,
	"call_id" uuid NOT NULL,
	"callback_e164" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"rung_at" timestamp with time zone,
	"rings" integer DEFAULT 0 NOT NULL,
	"legs_out" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"answered_by_user_id" uuid,
	"callback_call_id" uuid,
	"outcome" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queue_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "queue_wait_seconds" integer;--> statement-breakpoint
ALTER TABLE "call_queue" ADD COLUMN "offer_callback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_queue" ADD COLUMN "announce_wait" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_callback" ADD CONSTRAINT "queue_callback_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_callback" ADD CONSTRAINT "queue_callback_queue_id_call_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."call_queue"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_callback" ADD CONSTRAINT "queue_callback_call_id_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_callback" ADD CONSTRAINT "queue_callback_answered_by_user_id_user_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_callback" ADD CONSTRAINT "queue_callback_callback_call_id_call_id_fk" FOREIGN KEY ("callback_call_id") REFERENCES "public"."call"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "queue_callback_call_idx" ON "queue_callback" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_callback_waiting_idx" ON "queue_callback" USING btree ("organization_id","joined_at") WHERE "queue_callback"."status" in ('waiting', 'calling');