ALTER TABLE "expense" ADD COLUMN "miles" numeric(8, 1);--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "mileage_rate" numeric(7, 3);--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_miles_with_rate" CHECK (("expense"."miles" is null) = ("expense"."mileage_rate" is null));