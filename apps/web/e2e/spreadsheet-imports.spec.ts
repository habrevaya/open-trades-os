import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * BRINGING IN A SPREADSHEET, ON THE SCREENS
 *
 * An owner with a customer list and no programmer: upload it, see the columns
 * guessed and the rows that will not go in, check it, load it, download what
 * was refused, and bring the same file in again to find nothing doubled.
 */

const FORMULA = '=HYPERLINK("http://evil.example","Click me")';

function file(rows: string[][]): Buffer {
  const quoted = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
  return Buffer.from(`${quoted.join("\r\n")}\r\n`, "utf8");
}

test("Bring in a customer list: match the columns, check, load, and again without copies", async ({ owner, errors }) => {
  const source = `e2e-${run}`;
  const csv = file([
    ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
    [`A-${run}`, `Imported Ada ${run}`, `ada-${run}@example.com`, "1 Analytical Way", "Austin", "TX", "78701"],
    [`B-${run}`, `Imported Grace ${run}`, "", "2 Compiler Ct", "Austin", "TX", "78702"],
    [`C-${run}`, FORMULA, "", "3 Nowhere Ln", "", "", ""],
  ]);

  await owner.goto("/settings/imports");
  await expect(owner.getByRole("heading", { level: 1, name: "Bring in a spreadsheet" })).toBeVisible();
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await owner.getByLabel("The file (CSV)").setInputFiles({ name: `clients-${run}.csv`, mimeType: "text/csv", buffer: csv });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();

  await expect(owner.getByRole("heading", { level: 1, name: `clients-${run}.csv` })).toBeVisible();
  await expect(owner.getByRole("combobox", { name: /^Zip/ })).toHaveValue("zip");
  await expect(owner.getByRole("combobox", { name: /^Customer ID/ })).toHaveValue("ref");

  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByLabel("Save these columns as (optional)").fill(`Old list ${run}`);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: `kept as "Old list ${run}"` })).toBeVisible();

  const refused = owner.getByRole("table", { name: "Rows that will not go in" });
  await expect(refused).toContainText("The address is missing its city, state, zip");
  await expect(owner.getByRole("table", { name: "The first rows" })).toContainText(`Imported Ada ${run}`);

  await owner.getByRole("button", { name: "Check all 3 rows" }).click();
  await expect(owner.getByRole("button", { name: "Load 2 customers" })).toBeVisible();
  await owner.getByRole("button", { name: "Load 2 customers" }).click();
  await expect(owner.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(owner.getByText("2 loaded.")).toBeVisible();

  const db = createClient();
  const loaded = await db.execute<{ name: string }>(sql`
    select name from public.customer where source_system = ${source} order by source_id`);
  expect(loaded.map((r) => r.name)).toEqual([`Imported Ada ${run}`, `Imported Grace ${run}`]);

  const download = await owner.request.get(owner.url().replace(/\/?$/, "/refused"));
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toContain(`clients-${run}-refused.csv`);
  const text = await download.text();
  expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""Click me"")"`);
  expect(text).toContain("Refused because");

  /** The same file again: matched by itself, and nothing loaded twice. */
  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await owner.getByLabel("The file (CSV)").setInputFiles({ name: `clients-${run}-again.csv`, mimeType: "text/csv", buffer: csv });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByText(`matched with your saved columns "Old list ${run}"`)).toBeVisible();
  await owner.getByRole("button", { name: "Check all 3 rows" }).click();
  await expect(owner.getByRole("table", { name: "Skipped rows" })).toContainText(`Customer Imported Ada ${run}`);
  const after = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.customer where source_system = ${source}`);
  expect(Number(after[0]!.n)).toBe(2);
  expect(errors).toEqual([]);
});

test("A file too large is refused before it is sent", async ({ owner }) => {
  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Past invoices/ }).check();
  const big = Buffer.alloc(5 * 1024 * 1024 + 100, "a");
  await owner.getByLabel("The file (CSV)").setInputFiles({ name: "huge.csv", mimeType: "text/csv", buffer: big });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Bring in at most 5 MB at a time" })).toBeVisible();
});
