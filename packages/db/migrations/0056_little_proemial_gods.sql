DROP INDEX IF EXISTS "customer_source_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_source_ref_idx" ON "customer" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "property_source_ref_idx" ON "property" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_item_source_ref_idx" ON "price_book_item" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_source_ref_idx" ON "job" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "visit_source_ref_idx" ON "visit" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_source_ref_idx" ON "estimate" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_source_ref_idx" ON "invoice" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_source_ref_idx" ON "payment" USING btree ("organization_id","source_system","source_id") WHERE source_id is not null;