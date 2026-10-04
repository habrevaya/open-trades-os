ALTER TYPE "public"."accounting_entity_kind" ADD VALUE 'credit_note_refund' BEFORE 'journal';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_note_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"payment_id" uuid,
	"processor" text,
	"processor_refund_id" text,
	"reference" text,
	"paid_on" date,
	"paid_at" timestamp with time zone,
	"note" text,
	"failure_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "credit_note" ADD COLUMN "amount_paid_out" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "paid_out_amount" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_payout" ADD CONSTRAINT "credit_note_payout_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_payout" ADD CONSTRAINT "credit_note_payout_credit_note_id_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_note"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_payout" ADD CONSTRAINT "credit_note_payout_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_payout" ADD CONSTRAINT "credit_note_payout_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_payout_note_idx" ON "credit_note_payout" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_payout_refund_idx" ON "credit_note_payout" USING btree ("organization_id","processor_refund_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_payout_payment_idx" ON "credit_note_payout" USING btree ("payment_id");