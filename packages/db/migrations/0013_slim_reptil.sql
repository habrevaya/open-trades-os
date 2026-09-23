CREATE TABLE IF NOT EXISTS "event_cursor" (
	"organization_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_cursor_organization_id_consumer_pk" PRIMARY KEY("organization_id","consumer")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_cursor" ADD CONSTRAINT "event_cursor_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
