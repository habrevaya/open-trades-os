import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";
import { buildOds } from "../../../packages/api/test/ods-builder";

/**
 * BRINGING IN AN OPENDOCUMENT SPREADSHEET, ON THE SCREENS
 *
 * An owner with a LibreOffice file of several sheets: choose the .ods, see the
 * sheets with their rows, pick the customers one, match the columns, check, load.
 * A file that is another kind of OpenDocument is refused in words before
 * anything is kept, and an older .xls is still pointed at Save As.
 */
const ODS = "application/vnd.oasis.opendocument.spreadsheet";

test("Bring in one sheet of an .ods: pick the sheet, check, load", async ({ owner, errors }) => {
  const source = `e2e-ods-${run}`;
  const book = await buildOds([
    {
      name: "Customers",
      rows: [
        ["Customer ID", "Name", "Email", "Street", "City", "State", "Zip"],
        [`OA-${run}`, `Ods Ada ${run}`, `oada-${run}@example.com`, "1 Analytical Way", "Austin", "TX", 78701],
        [`OB-${run}`, `Ods Grace ${run}`, null, "2 Compiler Ct", "Austin", "TX", 78702],
        [`OC-${run}`, { formula: 'CONCATENATE("Ods ","Alan")', value: `Ods Alan ${run}` }, null, "3 Machine St", "Austin", "TX", 78703],
      ],
    },
    { name: "Cover", rows: [[null], ["Prepared by the office"]] },
  ]);

  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name: `office-${run}.ods`, mimeType: ODS, buffer: book });

  const sheets = owner.getByRole("group", { name: "Which sheet to bring in" });
  await expect(sheets).toBeVisible();
  await expect(sheets.getByRole("radio", { name: /^Customers/ })).toBeChecked();
  await expect(sheets).toContainText("3 rows. Columns: Customer ID, Name, Email");
  await expect(sheets.getByRole("radio", { name: /^Cover/ })).toBeDisabled();

  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `office-${run}.ods` })).toBeVisible();
  await expect(owner.getByText("Sheet: Customers.")).toBeVisible();

  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
  await owner.getByRole("button", { name: "Check all 3 rows" }).click();
  await owner.getByRole("button", { name: "Load 3 customers" }).click();
  await expect(owner.getByText("3 loaded.")).toBeVisible();

  const db = createClient();
  try {
    const loaded = await db.execute<{ name: string }>(sql`
      select c.name from public.customer c where c.source_system = ${source} order by c.source_id`);
    expect(loaded.map((r) => r.name)).toEqual([`Ods Ada ${run}`, `Ods Grace ${run}`, `Ods Alan ${run}`]);
  } finally {
    await db.$close();
  }
  expect(errors).toEqual([]);
});

test("An .ods that is not a spreadsheet, and an older .xls, are refused in words", async ({ owner }) => {
  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  const text = await buildOds([{ name: "Sheet1", rows: [["a"], ["b"]] }], { mimetype: "application/vnd.oasis.opendocument.text" });
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name: "letter.ods", mimeType: ODS, buffer: text });
  await expect(owner.getByRole("alert").filter({ hasText: "OpenDocument file, but not a spreadsheet" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Upload and match the columns" })).toBeDisabled();

  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({
    name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("not really"),
  });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "OpenDocument Spreadsheet (.ods)" })).toBeVisible();
});
