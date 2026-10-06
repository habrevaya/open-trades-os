CREATE TABLE IF NOT EXISTS "purchase_order_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"promised_on" date,
	"previous_promised_on" date,
	"reference" text,
	"note" text,
	"recorded_by_user_id" uuid,
	"recorded_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "promised_on" date;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_acknowledgement" ADD CONSTRAINT "purchase_order_acknowledgement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_acknowledgement" ADD CONSTRAINT "purchase_order_acknowledgement_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_order_acknowledgement" ADD CONSTRAINT "purchase_order_acknowledgement_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_order_acknowledgement_order_idx" ON "purchase_order_acknowledgement" USING btree ("organization_id","purchase_order_id","created_at");