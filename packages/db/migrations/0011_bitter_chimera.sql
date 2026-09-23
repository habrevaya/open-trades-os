-- Human-facing numbers become UNIQUE per organization.
--
-- They were allocated as max(number) + 1 with nothing serialising it, so two
-- concurrent bookings could be handed the same number. The allocator now takes
-- an advisory lock, and these indexes are what makes a duplicate impossible
-- rather than merely unlikely.
--
-- A database that already contains duplicates cannot have this index built,
-- and the error Postgres gives names the index rather than the problem. Say
-- it plainly first, because renumbering an invoice is a decision for whoever
-- runs the business, not for a migration: a number that has been on a
-- customer's invoice is not ours to change.
do $$
declare
  offender record;
begin
  for offender in
    select 'job' as t, organization_id, number, count(*) as n from public.job
      group by 1, 2, 3 having count(*) > 1
    union all
    select 'invoice', organization_id, number, count(*) from public.invoice
      group by 1, 2, 3 having count(*) > 1
    union all
    select 'estimate', organization_id, number, count(*) from public.estimate
      group by 1, 2, 3 having count(*) > 1
  loop
    raise exception using
      message = format(
        'duplicate %s number %s in organization %s (%s rows)',
        offender.t, offender.number, offender.organization_id, offender.n),
      hint = 'Renumber the later record by hand, then run this migration again. '
             'Which one keeps the number is a business decision.';
  end loop;
end $$;--> statement-breakpoint
DROP INDEX IF EXISTS "job_number_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_number_idx" ON "estimate" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_number_idx" ON "invoice" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_number_idx" ON "job" USING btree ("organization_id","number");
