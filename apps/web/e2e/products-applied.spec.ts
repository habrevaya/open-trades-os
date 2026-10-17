import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A PRODUCT APPLIED, CHOSEN FROM THE PRICE BOOK
 *
 * The office marks a material as a chemical on its price book page, with the
 * unit its cost is per and its EPA number. The technician then picks it by
 * name under "Products applied" on /my-day and types only how much, and the
 * visit's page in the office shows it as from the price book. The office can
 * record one the technician missed, refused in words for an amount that is not
 * a number. Pest control's chemical cost per stop is made from these.
 */

const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

const QUESTION = "Product applied, brand or product name";

/** A material in the book at $3 a unit, and a job type whose report asks what product was applied. */
async function setUp(product: string, jobTypeName: string): Promise<{ itemId: string; jobTypeId: string }> {
  const db = createClient();
  try {
    const [item] = await db.execute<{ id: string }>(sql`
      insert into public.price_book_item (organization_id, kind, code)
      select id, 'material', ${`CHEM-${run}`} from public.organization where slug = 'ridgeline' returning id`);
    await db.execute(sql`
      insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
      select organization_id, id, 1, ${product}, '12', '3', now() - interval '1 day' from public.price_book_item where id = ${item!.id}`);
    const [type] = await db.execute<{ id: string }>(sql`
      insert into public.job_type (organization_id, name, code, revenue_class)
      select id, ${jobTypeName}, ${`pest-${run}`}, 'recurring' from public.organization where slug = 'ridgeline' returning id`);
    await db.execute(sql`
      insert into public.service_report_template (organization_id, name, job_type_id, fields)
      select organization_id, ${jobTypeName}, id,
             ${JSON.stringify([{ key: "product_applied", label: QUESTION, kind: "chemical", regulated: true, required: true }])}::jsonb
        from public.job_type where id = ${type!.id}`);
    return { itemId: item!.id, jobTypeId: type!.id };
  } finally {
    await db.$close();
  }
}

/** The job just booked made one of that job type, and its visit's id. */
async function asPestJob(jobId: string, jobTypeId: string): Promise<string> {
  const db = createClient();
  try {
    await db.execute(sql`update public.job set job_type_id = ${jobTypeId} where id = ${jobId}`);
    const [visit] = await db.execute<{ id: string }>(sql`select id from public.visit where job_id = ${jobId} limit 1`);
    return visit!.id;
  } finally {
    await db.$close();
  }
}

test("a product applied is chosen from the price book on /my-day and in the office", async ({ tech, owner }) => {
  test.setTimeout(300_000);
  const product = `Bifen IT ${run}`;
  const customer = `Pat Pests ${run}`;
  const { itemId, jobTypeId } = await setUp(product, `Quarterly pest ${run}`);

  // The office marks it as a chemical.
  await owner.goto(`/pricebook/items/${itemId}`);
  const mark = owner.getByRole("region", { name: "A chemical your technicians apply" });
  await mark.getByLabel("Unit its cost is per, like gal or oz").fill("gal");
  await mark.getByLabel("EPA registration number, from the label").fill("279-3206");
  await mark.getByRole("button", { name: "Mark as a chemical" }).click();
  await expect(owner.getByText("Chemical, per gal")).toBeVisible();

  // A visit today for the technician, of a job type whose report asks what was applied.
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0141",
    address: { street: "9 Ant Hill Road", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "9 Ant Hill Road, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Quarterly pest ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(companyToday());
  await owner.getByLabel("Arrives from").fill("21:30");
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const visitId = await asPestJob(owner.url().split("/").pop()!, jobTypeId);

  // The technician picks it by name and types only how much.
  await tech.goto("/my-day");
  await ready(tech);
  const card = tech.getByRole("article").filter({ hasText: customer });
  await card.getByRole("button").first().click();
  const products = card.getByRole("region", { name: "Products applied" });
  await products.getByLabel(`${QUESTION}: product`, { exact: true }).selectOption({ label: product });
  await products.getByLabel(`${QUESTION}: how much`, { exact: true }).fill("a splash");
  await products.getByRole("button", { name: "Save", exact: true }).click();
  await expect(products.getByRole("alert").filter({ hasText: "as a number" })).toBeVisible();
  await products.getByLabel(`${QUESTION}: how much`, { exact: true }).fill("2");
  await products.getByRole("button", { name: "Save", exact: true }).click();
  await expect(products).toContainText(`Recorded: ${product}`);

  // The office sees it on the visit, from the price book, with the book's EPA number.
  await expect(async () => {
    await owner.goto(`/visits/${visitId}`);
    const row = owner.getByRole("region", { name: "Products applied" }).getByRole("row").filter({ hasText: product });
    await expect(row).toContainText("279-3206", { timeout: 2_000 });
    await expect(row).toContainText("2 gal", { timeout: 2_000 });
    await expect(row).toContainText("Price book", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // And records one the technician missed, refused in words first.
  const section = owner.getByRole("region", { name: "Products applied" });
  await section.getByRole("combobox", { name: "Product", exact: true }).selectOption({ label: `${product}, per gal` });
  await section.getByRole("textbox", { name: "How much", exact: true }).fill("lots");
  await section.getByRole("button", { name: "Record the product" }).click();
  await expect(section.getByRole("alert").filter({ hasText: "more than nought" })).toBeVisible();
  await section.getByRole("textbox", { name: "How much", exact: true }).fill("1.5");
  await section.getByRole("textbox", { name: "Target pest" }).fill("Ants");
  await section.getByRole("button", { name: "Record the product" }).click();
  await expect(section.getByRole("row").filter({ hasText: product })).toContainText("1.5 gal");
});
