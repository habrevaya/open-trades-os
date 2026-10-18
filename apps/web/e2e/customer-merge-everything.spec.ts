import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A MERGE BRINGS EVERYTHING, AND SAYS WHAT IT COULD NOT
 *
 * The duplicate has a credit note and two monthly statements, one for a month
 * the record kept already had a statement for. The merge brings the credit
 * note and the August statement, and the page says the September one stayed
 * with the duplicate and why, right after the merge and on the record kept's
 * list of merges. Taking the merge back takes the credit note with it.
 */
test("a merge brings a credit note and says which statement stayed behind", async ({ owner }) => {
  const digits = [...run.slice(-4)].map((c) => c.charCodeAt(0) % 10).join("");
  const phone = `512557${digits}`;
  const kept = await newCustomer(owner, { name: `Omar Keeps ${run}`, phone });
  const other = await newCustomer(owner, { name: `Omar Twice ${run}`, phone });

  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.credit_note (organization_id, number, customer_id, reason)
      select organization_id,
        (select coalesce(max(number), 0) + 1 from public.credit_note n where n.organization_id = c.organization_id),
        id, 'goodwill'
      from public.customer c where id = ${other}`);
    await db.execute(sql`
      insert into public.statement_delivery (organization_id, customer_id, period, period_from, period_to)
      select organization_id, id, p.period, p.from_day::date, p.to_day::date
      from public.customer c,
        (values (${other}::uuid, '2026-08', '2026-08-01', '2026-08-31'),
                (${other}::uuid, '2026-09', '2026-09-01', '2026-09-30'),
                (${kept}::uuid, '2026-09', '2026-09-01', '2026-09-30')) as p(who, period, from_day, to_day)
      where c.id = p.who`);
  } finally {
    await db.$close();
  }

  await owner.goto(`/customers/${kept}`);
  await owner.getByRole("button", { name: /Merge a duplicate into this one/ }).click();
  await owner.getByLabel("Which record is the duplicate").selectOption(other);
  await owner.getByRole("button", { name: `Merge into Omar Keeps ${run}` }).click();

  await expect(owner.getByText("These stayed with the duplicate:")).toBeVisible();
  await expect(owner.getByText("1 statement sent: The record kept was sent its own statement for the same month."))
    .toBeVisible();

  const merged = owner.getByRole("region", { name: "Merged into this record" });
  await expect(merged).toContainText("1 credit note");
  await expect(merged).toContainText("1 statement sent");
  const stayed = merged.getByRole("list", { name: "Stayed with the duplicate" });
  await expect(stayed).toContainText("1 statement sent. The record kept was sent its own statement for the same month.");

  await merged.getByRole("button", { name: "Undo this merge" }).click();
  await expect(merged).toContainText("Undone on");
});
