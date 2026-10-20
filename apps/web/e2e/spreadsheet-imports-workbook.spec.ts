import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";
import { buildWorkbook } from "../../../packages/api/test/xlsx-builder";

/**
 * BRINGING IN A WORKBOOK, ON THE SCREENS
 *
 * An owner with an Excel file of several sheets: choose the file, see the
 * sheets with their rows, pick the customers one, match the columns, check,
 * load. A sheet that is not a list is shown with why it cannot be chosen, and
 * a file that is not a workbook is refused in words before anything is kept.
 */

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("Bring in one sheet of a workbook: pick the sheet, check, load", async ({ owner, errors }) => {
  const source = `e2e-book-${run}`;
  const book = await buildWorkbook([
    {
      name: "Customers",
      rows: [
        ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
        [`WA-${run}`, `Workbook Ada ${run}`, `wada-${run}@example.com`, "1 Analytical Way", "Austin", "TX", 78701],
        [`WB-${run}`, `Workbook Grace ${run}`, null, "2 Compiler Ct", "Austin", "TX", 78702],
        [`WC-${run}`, { formula: 'CONCATENATE("Workbook ","Alan")', value: `Workbook Alan ${run}` }, null, "3 Machine St", "Austin", "TX", 78703],
      ],
    },
    { name: "Cover", rows: [[null], ["Prepared by the office"]] },
    { name: "Notes", rows: [["Customer ID", "Note", "Date"], [`WA-${run}`, "Asked about the furnace", new Date(Date.UTC(2021, 2, 4))]] },
  ]);

  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name: `office-${run}.xlsx`, mimeType: XLSX, buffer: book });

  const sheets = owner.getByRole("group", { name: "Which sheet to bring in" });
  await expect(sheets).toBeVisible();
  await expect(sheets.getByRole("radio", { name: /^Customers/ })).toBeChecked();
  await expect(sheets).toContainText("3 rows. Columns: Customer ID, Name, Email");
  await expect(sheets.getByRole("radio", { name: /^Cover/ })).toBeDisabled();
  await expect(sheets).toContainText("Cannot be brought in. The first row of the sheet \"Cover\" is empty");
  await expect(sheets.getByRole("radio", { name: /^Notes/ })).toBeEnabled();

  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `office-${run}.xlsx` })).toBeVisible();
  await expect(owner.getByText("Sheet: Customers.")).toBeVisible();
  await expect(owner.getByRole("combobox", { name: /^Zip/ })).toHaveValue("zip");

  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
  await expect(owner.getByRole("table", { name: "The first rows" })).toContainText(`Workbook Ada ${run}`);

  await owner.getByRole("button", { name: "Check all 3 rows" }).click();
  await owner.getByRole("button", { name: "Load 3 customers" }).click();
  await expect(owner.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(owner.getByText("3 loaded.")).toBeVisible();

  const db = createClient();
  const loaded = await db.execute<{ name: string; zip: string | null }>(sql`
    select c.name from public.customer c where c.source_system = ${source} order by c.source_id`);
  expect(loaded.map((r) => r.name)).toEqual([`Workbook Ada ${run}`, `Workbook Grace ${run}`, `Workbook Alan ${run}`]);

  /** The list of files says which sheet each came from. */
  await owner.goto("/settings/imports");
  await expect(owner.getByRole("table", { name: "Files brought in" }).filter({ hasText: `office-${run}.xlsx` })).toContainText("Sheet: Customers");
  expect(errors).toEqual([]);
});

test("A file that is not a workbook, and a workbook that is not a list, are refused in words", async ({ owner }) => {
  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({
    name: "pretend.xlsx", mimeType: XLSX, buffer: Buffer.from("Name,Email\r\nAda,ada@example.com\r\n"),
  });
  await expect(owner.getByRole("alert").filter({ hasText: "That does not look like an .xlsx workbook" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Upload and match the columns" })).toBeDisabled();

  const lists = await buildWorkbook([{ name: "Cover", rows: [[null], ["Nothing to bring in"]] }]);
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name: "cover.xlsx", mimeType: XLSX, buffer: lists });
  await expect(owner.getByRole("group", { name: "Which sheet to bring in" })).toContainText("Cannot be brought in");
  await expect(owner.getByRole("button", { name: "Upload and match the columns" })).toBeDisabled();

  const old = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: old });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "That kind of workbook cannot be read" })).toBeVisible();
});
