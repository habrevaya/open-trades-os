ALTER TABLE "job_line" ADD COLUMN "rental_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line" ADD COLUMN "rental_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_line" ADD CONSTRAINT "job_line_rental_id_rental_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rental"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_rental_id_rental_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rental"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
