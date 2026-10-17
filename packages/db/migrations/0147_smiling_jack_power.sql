ALTER TABLE "per_diem" ADD COLUMN "place_id" uuid;--> statement-breakpoint
ALTER TABLE "per_diem" ADD COLUMN "place_name" text;--> statement-breakpoint
ALTER TABLE "per_diem" ADD CONSTRAINT "per_diem_place_named" CHECK (("per_diem"."place_id" is null) = ("per_diem"."place_name" is null));