import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * THE LAST GAPS IN BRINGING IN A SPREADSHEET, ON THE SCREENS
 *
 * An invoice line that names its price book item and a discount, a note written
 * at a time, and an estimate turned into a job on a day: the new columns are
 * guessed from their headers, a line that disagrees with its discount is shown
 * among the rows that will not go in, and what loads is read back from the tables.
 */

const csv = (rows: string[][]): Buffer =>
  Buffer.from(`${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`, "utf8");

test("Bring in invoice lines with an item and a discount, a note with a time, and an estimate that became a job", async ({ owner, errors }) => {
  const source = `e2e-polish-${run}`;
  const customer = `PL-${run}`;
  const code = `PLT-${run}`.toUpperCase();
  const invoice = `PI-${run}`;
  const badInvoice = `PB-${run}`;
  const estimate = String(Number.parseInt(run, 36) % 900_000 + 100_000);

  async function upload(kind: RegExp, name: string, rows: string[][]) {
    await owner.goto("/settings/imports");
    await owner.getByRole("radio", { name: kind }).check();
    await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name, mimeType: "text/csv", buffer: csv(rows) });
    await owner.getByRole("button", { name: "Upload and match the columns" }).click();
    await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
    await owner.getByLabel("Where these came from").fill(source);
    await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
  }

  await upload(/^Customers/, `polish-customers-${run}.csv`, [
    ["Customer ID", "Name", "Street", "City", "State", "Zip"],
    [customer, `Polish Customer ${run}`, "9 Polish Street", "Austin", "TX", "78701"],
  ]);
  await owner.getByRole("button", { name: "Check all 1 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 customer" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await upload(/^Price book items/, `polish-items-${run}.csv`, [
    ["Code", "Name", "Price"],
    [code, `Polish filter ${run}`, "50.00"],
  ]);
  await owner.getByRole("button", { name: "Check all 1 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 item" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await upload(/^Past invoices/, `polish-invoices-${run}.csv`, [
    ["Invoice ID", "Customer ID", "Invoice Date", "Item code", "Description", "Qty", "Price Each", "Discount", "Before tax", "Tax", "Total"],
    [invoice, customer, "2022-04-01", code, "Filters for the shop", "2", "50", "10", "90.00", "0", "90.00"],
    [badInvoice, customer, "2022-04-02", code, "Filters again", "2", "50", "10", "100.00", "0", "100.00"],
  ]);
  await expect(owner.getByRole("combobox", { name: /^Price book item/ })).toHaveValue("itemRef");
  await expect(owner.getByRole("combobox", { name: /^Discount/ })).toHaveValue("discount");
  const refused = owner.getByRole("table", { name: "Rows that will not go in" });
  await expect(refused).toContainText("2 at 50.00 less 10.00 is 90.00, not the 100.00 in Before tax");
  await owner.getByRole("button", { name: "Check all 2 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 row" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await upload(/^Customer notes/, `polish-notes-${run}.csv`, [
    ["Note ID", "Customer ID", "Date", "Time", "Note"],
    [`N-${run}`, customer, "2021-03-04", "2:30 PM", "Gate sticks."],
  ]);
  await expect(owner.getByRole("combobox", { name: /^Time written/ })).toHaveValue("notedTime");
  await owner.getByRole("button", { name: "Check all 1 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 note" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await upload(/^Past estimates/, `polish-estimates-${run}.csv`, [
    ["Estimate #", "Customer ID", "Date", "Line item", "Qty", "Price Each", "Total", "Status", "Decided On", "Converted On"],
    [estimate, customer, "2022-02-01", "Heat pump", "1", "1000", "1000", "Won", "2022-02-10", "2022-03-01"],
  ]);
  await expect(owner.getByRole("combobox", { name: /^Turned into a job on/ })).toHaveValue("convertedOn");
  await owner.getByRole("button", { name: "Check all 1 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 row" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  const db = createClient();
  const lines = await db.execute<{ name: string; discount: string; item: string | null }>(sql`
    select l.name, l.discount_amount::text as discount, pi.code as item
    from public.invoice_line l join public.invoice i on i.id = l.invoice_id
    left join public.price_book_item_version v on v.id = l.price_book_item_version_id
    left join public.price_book_item pi on pi.id = v.item_id
    where i.source_system = ${source} order by i.source_id`);
  expect(lines.map((l) => [l.name, Number(l.discount), l.item])).toEqual([["Filters for the shop", 10, code]]);
  const note = await db.execute<{ at: string }>(sql`
    select to_char(noted_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as at
    from public.customer_note where source_system = ${source}`);
  expect(note[0]!.at).toBe("2021-03-04 14:30");
  const made = await db.execute<{ status: string; day: string }>(sql`
    select status::text, (converted_at at time zone 'America/Chicago')::date::text as day
    from public.estimate where source_system = ${source} and source_id = ${estimate}`);
  expect(made[0]).toMatchObject({ status: "converted", day: "2022-03-01" });
  expect(errors).toEqual([]);
});
