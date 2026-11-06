import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * EITHER UNIT FOR A CHEMICAL CHOSEN ON /my-day
 *
 * A concentrate bought by the gallon and used by the ounce. The office's
 * visit page could record it in either; /my-day only in ounces. Now the
 * technician picks the unit under "Products applied", and the office sees the
 * application in the unit picked, as if it had recorded it itself.
 */

const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);
const QUESTION = "Product applied, brand or product name";

test("a technician records a concentrate in gallons on /my-day", async ({ tech, owner }) => {
  test.setTimeout(300_000);
  const product = `Concentrate ${run}`;
  const customer = `Ula Units ${run}`;
  const jobTypeName = `Quarterly units ${run}`;
  const db = createClient();
  let jobTypeId = "";
  try {
    const [item] = await db.execute<{ id: string }>(sql`
      insert into public.price_book_item (organization_id, kind, code, chemical_unit, epa_registration_number)
      select id, 'material', ${`CONC-${run}`}, 'oz', '100-1' from public.organization where slug = 'ridgeline' returning id`);
    await db.execute(sql`
      insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, buy_unit, use_unit, use_per_buy, effective_from)
      select organization_id, id, 1, ${product}, '1.50', '40', 'gal', 'oz', '128', now() - interval '1 day'
        from public.price_book_item where id = ${item!.id}`);
    const [type] = await db.execute<{ id: string }>(sql`
      insert into public.job_type (organization_id, name, code, revenue_class)
      select id, ${jobTypeName}, ${`units-${run}`}, 'recurring' from public.organization where slug = 'ridgeline' returning id`);
    jobTypeId = type!.id;
    await db.execute(sql`
      insert into public.service_report_template (organization_id, name, job_type_id, fields)
      select organization_id, ${jobTypeName}, id,
             ${JSON.stringify([{ key: "product_applied", label: QUESTION, kind: "chemical", regulated: true, required: true }])}::jsonb
        from public.job_type where id = ${jobTypeId}`);
  } finally {
    await db.$close();
  }

  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0143",
    address: { street: "11 Ant Hill Road", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "11 Ant Hill Road, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(jobTypeName);
  await owner.getByLabel("Day", { exact: true }).fill(companyToday());
  await owner.getByLabel("Arrives from").fill("21:40");
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobId = owner.url().split("/").pop()!;
  const set = createClient();
  let visitId = "";
  try {
    await set.execute(sql`update public.job set job_type_id = ${jobTypeId} where id = ${jobId}`);
    const [visit] = await set.execute<{ id: string }>(sql`select id from public.visit where job_id = ${jobId} limit 1`);
    visitId = visit!.id;
  } finally {
    await set.$close();
  }

  await tech.goto("/my-day");
  await ready(tech);
  const card = tech.getByRole("article").filter({ hasText: customer });
  await card.getByRole("button").first().click();
  const products = card.getByRole("region", { name: "Products applied" });
  await products.getByLabel(`${QUESTION}: product`, { exact: true }).selectOption({ label: product });
  const unit = products.getByLabel(`${QUESTION}: in what unit`, { exact: true });
  await expect(unit).toHaveValue("oz");
  await unit.selectOption("gal");
  await expect(products.getByText("How much, gal")).toBeVisible();
  await products.getByLabel(`${QUESTION}: how much`, { exact: true }).fill("0.5");
  await products.getByRole("button", { name: "Save", exact: true }).click();
  await expect(products).toContainText(`Recorded: ${product}`);

  // The office sees it in gallons, from the price book, as if it had recorded it there.
  await expect(async () => {
    await owner.goto(`/visits/${visitId}`);
    const row = owner.getByRole("region", { name: "Products applied" }).getByRole("row").filter({ hasText: product });
    await expect(row).toContainText("0.5 gal", { timeout: 2_000 });
    await expect(row).toContainText("Price book", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});
