import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * BRINGING IN ESTIMATES WITH OPTIONS, ON THE SCREENS
 *
 * A file with a row per line brings in one estimate with its options: the
 * columns that group the lines are matched, an estimate that disagrees with
 * itself is shown among the rows that will not go in with the reason, and the
 * one that holds together is loaded with each option's total as the file had it.
 */

const csv = (rows: string[][]): Buffer =>
  Buffer.from(`${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`, "utf8");

test("Bring in an estimate with two options and several lines", async ({ owner, errors }) => {
  const source = `e2e-est-${run}`;
  const customer = `EST-${run}`;
  const number = String(Number.parseInt(run, 36) % 900_000 + 100_000);
  const refusedNumber = String(Number(number) + 1);

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

  await upload(/^Customers/, `estimate-customers-${run}.csv`, [
    ["Customer ID", "Name", "Street", "City", "State", "Zip"],
    [customer, `Estimate Customer ${run}`, "7 Quote Street", "Austin", "TX", "78701"],
  ]);
  await owner.getByRole("button", { name: "Check all 1 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 customer" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  /** Good: 3000 + 150 + 247.50 tax = 3397.50. Better: 4200 + 150 + 346.50 tax = 4696.50. The second estimate's total is wrong. */
  const header = ["Estimate #", "Customer ID", "Title", "Date", "Option", "Line item", "Qty", "Price Each", "Tax", "Total", "Recommended"];
  await upload(/^Past estimates/, `estimates-${run}.csv`, [
    header,
    [number, customer, "New furnace", "2022-02-01", "Good", "Furnace", "1", "3000", "247.50", "3397.50", "no"],
    [number, "", "", "", "Good", "Install", "5", "30", "0", "3397.50", ""],
    [number, "", "", "", "Better", "Furnace plus filter", "1", "4200", "346.50", "4696.50", "yes"],
    [number, "", "", "", "Better", "Install", "5", "30", "0", "4696.50", ""],
    [refusedNumber, customer, "Duct cleaning", "2022-03-01", "Only", "Ducts", "1", "500", "0", "600", ""],
  ]);
  await expect(owner.getByRole("combobox", { name: /^Option/ })).toHaveValue("option");
  await expect(owner.getByRole("combobox", { name: /^Line item/ })).toHaveValue("lineName");
  await expect(owner.getByRole("table", { name: "The first rows" })).toContainText("Furnace plus filter");

  const refused = owner.getByRole("table", { name: "Rows that will not go in" });
  await expect(refused).toContainText('Before tax 500.00 and tax 0.00 come to 500.00, not the 600.00 in Total');

  await owner.getByRole("button", { name: "Check all 5 rows" }).click();
  await owner.getByRole("button", { name: "Load 4 rows" }).click();
  await expect(owner.getByText("4 loaded.")).toBeVisible();

  const db = createClient();
  const options = await db.execute<{ name: string; total: string; lines: number }>(sql`
    select o.name, o.total::text, (select count(*)::int from public.estimate_line l where l.option_id = o.id) as lines
    from public.estimate_option o join public.estimate e on e.id = o.estimate_id
    where e.source_system = ${source} and e.source_id = ${number} order by o.name`);
  expect(options.map((o) => [o.name, Number(o.total), o.lines])).toEqual([["Better", 4696.5, 2], ["Good", 3397.5, 2]]);
  const none = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.estimate where source_system = ${source} and source_id = ${refusedNumber}`);
  expect(Number(none[0]!.n)).toBe(0);
  expect(errors).toEqual([]);
});
