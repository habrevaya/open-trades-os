ALTER TABLE "estimate" ADD COLUMN "issued_on" date;--> statement-breakpoint
-- Every estimate written before this column existed was written on the day its
-- row was created, read in its company's own calendar.
UPDATE "estimate" e SET "issued_on" = (e."created_at" AT TIME ZONE coalesce(o."timezone", 'America/Chicago'))::date
FROM "organization" o WHERE o."id" = e."organization_id" AND e."issued_on" IS NULL;
