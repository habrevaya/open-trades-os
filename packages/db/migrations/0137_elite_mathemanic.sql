ALTER TABLE "commission_event" ADD COLUMN "item_rule" text DEFAULT 'plan_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_event" ADD COLUMN "lines" jsonb DEFAULT '[]'::jsonb NOT NULL;