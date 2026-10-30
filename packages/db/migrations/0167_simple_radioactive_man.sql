CREATE TABLE IF NOT EXISTS "job_cost_not_same" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"job_line_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"note" text,
	"marked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_cost_not_same" ADD CONSTRAINT "job_cost_not_same_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_cost_not_same" ADD CONSTRAINT "job_cost_not_same_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_cost_not_same" ADD CONSTRAINT "job_cost_not_same_job_line_id_job_line_id_fk" FOREIGN KEY ("job_line_id") REFERENCES "public"."job_line"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_cost_not_same" ADD CONSTRAINT "job_cost_not_same_ledger_entry_id_ledger_entry_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_cost_not_same" ADD CONSTRAINT "job_cost_not_same_marked_by_user_id_user_id_fk" FOREIGN KEY ("marked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_cost_not_same_pair_idx" ON "job_cost_not_same" USING btree ("organization_id","job_line_id","ledger_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_cost_not_same_job_idx" ON "job_cost_not_same" USING btree ("job_id");