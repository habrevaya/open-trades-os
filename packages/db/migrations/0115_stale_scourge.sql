ALTER TABLE "domain_event" ADD COLUMN "import_run_id" uuid;--> statement-breakpoint
ALTER TABLE "import_row" ADD COLUMN "part_of" integer;--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN "hold_automations" boolean DEFAULT true NOT NULL;