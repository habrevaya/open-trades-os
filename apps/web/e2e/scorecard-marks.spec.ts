import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A HAND MADE DRAIN CALL AND CAMERA ITEM, MARKED AS THE TRADE PACK'S
 *
 * The seeded company is HVAC, so this spec makes it a plumbing company for the
 * length of one test (the suite runs one test at a time) and puts it back. It
 * has a job type of its own, "Sewer call", and an item of its own, a scope
 * camera. On What the scorecard counts the page says what marking changes in
 * Drain call conversion; the office marks the sewer call as a drain call and
 * the camera as drain call upsell work, and both are kept. The marks and the
 * two records are taken off at the end.
 */

test("Trade scorecard: a hand made job type and item marked as the drain call and its upsell", async ({ owner }) => {
  const typeName = `Sewer call ${run}`;
  const itemName = `Scope camera ${run}`;
  const db = createClient();
  let trade: string | null = null;
  try {
    const [org] = await db.execute<{ primary_trade: string | null }>(sql`
      select primary_trade from public.organization where slug = 'ridgeline'`);
    trade = org?.primary_trade ?? null;
    await db.execute(sql`update public.organization set primary_trade = 'plumbing' where slug = 'ridgeline'`);
    await db.execute(sql`
      insert into public.job_type (organization_id, name, code, revenue_class)
      select id, ${typeName}, ${`sewer-${run}`}, 'service' from public.organization where slug = 'ridgeline'`);
    await db.execute(sql`
      with i as (
        insert into public.price_book_item (organization_id, code, kind)
        select id, ${`SCOPE-${run}`}, 'service' from public.organization where slug = 'ridgeline' returning id, organization_id
      )
      insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
      select organization_id, id, 1, ${itemName}, '250', now() - interval '1 day' from i`);

    await owner.goto("/reports/scorecard");
    await owner.getByRole("link", { name: "Choose what the scorecard counts" }).click();
    await expect(owner).toHaveURL(/\/reports\/scorecard\/marks/);
    await expect(owner.getByRole("region", { name: "What marking changes" })).toContainText("Drain call conversion.");
    await expect(owner.getByText("A job type marked drain call: Its finished jobs count as drain calls")).toBeVisible();

    const row = owner.getByRole("row").filter({ hasText: typeName });
    await row.getByLabel(`${typeName} is a drain call`).check();
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("button", { name: "Save" })).toBeEnabled();

    await owner.getByLabel("Item to mark").selectOption({ label: `${itemName} (SCOPE-${run})` });
    await owner.getByLabel("The item is a drain call upsell").check();
    await owner.getByRole("button", { name: "Mark it" }).click();
    const marked = owner.getByRole("table", { name: "Marked items" }).getByRole("row").filter({ hasText: itemName });
    await expect(marked.getByLabel(`${itemName} is a drain call upsell`)).toBeChecked();

    await owner.reload();
    await expect(owner.getByRole("row").filter({ hasText: typeName }).getByLabel(`${typeName} is a drain call`)).toBeChecked();
  } finally {
    await db.execute(sql`delete from public.price_book_item where code = ${`SCOPE-${run}`}`);
    await db.execute(sql`delete from public.job_type where code = ${`sewer-${run}`}`);
    await db.execute(sql`update public.organization set primary_trade = ${trade} where slug = 'ridgeline'`);
    await db.$close();
  }
});
