-- The generated version of this migration dropped the type and cast the
-- column straight into the new one. Every existing row holding 'job' or
-- 'break' would have failed that cast, and a deployment with any timeclock
-- history at all would have stopped mid-migration.
--
-- 'job' becomes 'on_site', which is a rename: the same fact under the name
-- core uses.
--
-- 'break' becomes 'unpaid_break', and that choice is worth stating because it
-- is not symmetric. The old enum could not say which kind of break it was, so
-- the data does not contain the answer. Treating an unknown break as UNPAID
-- keeps it out of the overtime pot and out of the pay total, which under-pays
-- nobody: a paid break wrongly marked unpaid shows up as somebody's hours
-- being lower than they expect, which they notice and report. The other way
-- round, an unpaid break wrongly marked paid, silently pays for time nobody
-- worked and nobody ever reports it.
ALTER TABLE "timeclock_entry" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."timeclock_entry" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."timeclock_entry" SET "kind" = 'on_site' WHERE "kind" = 'job';--> statement-breakpoint
UPDATE "public"."timeclock_entry" SET "kind" = 'unpaid_break' WHERE "kind" = 'break';--> statement-breakpoint
DROP TYPE "public"."time_entry_kind";--> statement-breakpoint
CREATE TYPE "public"."time_entry_kind" AS ENUM('travel', 'on_site', 'shop', 'unpaid_break', 'paid_break', 'on_call', 'training', 'pto', 'holiday');--> statement-breakpoint
ALTER TABLE "public"."timeclock_entry" ALTER COLUMN "kind" SET DATA TYPE "public"."time_entry_kind" USING "kind"::"public"."time_entry_kind";--> statement-breakpoint
ALTER TABLE "timeclock_entry" ALTER COLUMN "kind" SET DEFAULT 'on_site';
