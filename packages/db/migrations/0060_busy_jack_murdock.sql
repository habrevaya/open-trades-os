ALTER TABLE "rental" ADD COLUMN "previous_rental_id" uuid;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_ticket_number" text;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "disposal_facility" text;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "material_type" text;--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "diverted_tons" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "included_tons" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "rental" ADD COLUMN "per_ton_rate" numeric(14, 4);