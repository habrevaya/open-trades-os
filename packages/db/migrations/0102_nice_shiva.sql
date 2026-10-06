CREATE TABLE IF NOT EXISTS "cash_tip_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cash_tip_id" uuid NOT NULL,
	"previous_amount" numeric(14, 4) NOT NULL,
	"new_amount" numeric(14, 4) NOT NULL,
	"reason" text NOT NULL,
	"corrected_by_user_id" uuid,
	"corrected_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_tip" ADD COLUMN "recorded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_tip" ADD COLUMN "recorded_by_name" text;--> statement-breakpoint
ALTER TABLE "tip_share" ADD COLUMN "split_rule" text DEFAULT 'even' NOT NULL;--> statement-breakpoint
ALTER TABLE "tip_share" ADD COLUMN "split_note" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip_correction" ADD CONSTRAINT "cash_tip_correction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip_correction" ADD CONSTRAINT "cash_tip_correction_cash_tip_id_cash_tip_id_fk" FOREIGN KEY ("cash_tip_id") REFERENCES "public"."cash_tip"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip_correction" ADD CONSTRAINT "cash_tip_correction_corrected_by_user_id_user_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_tip_correction_tip_idx" ON "cash_tip_correction" USING btree ("organization_id","cash_tip_id","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cash_tip" ADD CONSTRAINT "cash_tip_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
