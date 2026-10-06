CREATE TABLE IF NOT EXISTS "card_on_file_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"saved_payment_method_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"requested_by_user_id" uuid,
	"status" text DEFAULT 'charging' NOT NULL,
	"amount" numeric(14, 4),
	"attempt_event_id" uuid,
	"intent_id" text,
	"failure_code" text,
	"failure_reason" text,
	"retry_at" timestamp with time zone,
	"customer_told" text,
	"customer_told_note" text,
	"task_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_agreement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"saved_payment_method_id" uuid NOT NULL,
	"wording" text NOT NULL,
	"agreed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agreed_via" text NOT NULL,
	"grant_id" uuid,
	"contact_id" uuid,
	"ip" text,
	"user_agent" text,
	"autopay_at" timestamp with time zone,
	"autopay_wording" text,
	"autopay_grant_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"withdrawn_grant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_on_file_charge" ADD CONSTRAINT "card_on_file_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_on_file_charge" ADD CONSTRAINT "card_on_file_charge_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_on_file_charge" ADD CONSTRAINT "card_on_file_charge_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_on_file_charge" ADD CONSTRAINT "card_on_file_charge_agreement_id_payment_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."payment_agreement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_on_file_charge" ADD CONSTRAINT "card_on_file_charge_saved_payment_method_id_saved_payment_method_id_fk" FOREIGN KEY ("saved_payment_method_id") REFERENCES "public"."saved_payment_method"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_on_file_charge" ADD CONSTRAINT "card_on_file_charge_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_saved_payment_method_id_saved_payment_method_id_fk" FOREIGN KEY ("saved_payment_method_id") REFERENCES "public"."saved_payment_method"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_grant_id_portal_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_autopay_grant_id_portal_grant_id_fk" FOREIGN KEY ("autopay_grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_withdrawn_grant_id_portal_grant_id_fk" FOREIGN KEY ("withdrawn_grant_id") REFERENCES "public"."portal_grant"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_on_file_charge_autopay_idx" ON "card_on_file_charge" USING btree ("organization_id","invoice_id","attempt") WHERE "card_on_file_charge"."trigger" = 'autopay';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_on_file_charge_key_idx" ON "card_on_file_charge" USING btree ("organization_id","idempotency_key") WHERE "card_on_file_charge"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_on_file_charge_invoice_idx" ON "card_on_file_charge" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_on_file_charge_open_idx" ON "card_on_file_charge" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_agreement_live_idx" ON "payment_agreement" USING btree ("organization_id","saved_payment_method_id") WHERE "payment_agreement"."withdrawn_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_agreement_autopay_idx" ON "payment_agreement" USING btree ("organization_id","customer_id") WHERE "payment_agreement"."withdrawn_at" is null and "payment_agreement"."autopay_at" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_agreement_customer_idx" ON "payment_agreement" USING btree ("organization_id","customer_id");