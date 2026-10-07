ALTER TABLE "payment_agreement" ADD COLUMN "given_by" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "agreed_on" date;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "taken_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "taken_by_name" text;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "form_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD COLUMN "withdrawn_by_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_taken_by_user_id_user_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_form_attachment_id_attachment_id_fk" FOREIGN KEY ("form_attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_withdrawn_by_user_id_user_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_paper_needs_form" CHECK ("payment_agreement"."agreed_via" <> 'office_form' or "payment_agreement"."form_attachment_id" is not null);--> statement-breakpoint
ALTER TABLE "payment_agreement" ADD CONSTRAINT "payment_agreement_given_by_way" CHECK (("payment_agreement"."given_by" = 'customer' and "payment_agreement"."agreed_via" = 'portal_sign_in')
      or ("payment_agreement"."given_by" = 'office' and "payment_agreement"."agreed_via" in ('office_phone', 'office_form') and "payment_agreement"."agreed_on" is not null));