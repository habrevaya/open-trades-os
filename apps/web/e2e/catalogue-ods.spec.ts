import { test, expect, run } from "./fixtures";
import { buildOds } from "../../../packages/api/test/ods-builder";

/**
 * A SUPPLIER'S CATALOGUE SAVED FROM LIBREOFFICE
 *
 * The catalogue screen used to turn an .ods away before it was read, though the
 * reader behind it (the spreadsheet import's) reads one. The owner picks the
 * .ods, is asked which sheet holds the prices, previews and applies it, as with
 * an .xlsx.
 */
const ODS = "application/vnd.oasis.opendocument.spreadsheet";

test("a catalogue saved as .ods: choose the sheet, preview, apply", async ({ owner, errors }) => {
  const vendor = `Ods Supply ${run}`;
  const sku = `OD${run.slice(-6).toUpperCase()}`;
  const book = await buildOds([
    { name: "Cover", rows: [["Prices effective this month"]] },
    {
      name: "Prices",
      rows: [
        ["sku", "description", "cost", "vendor"],
        [sku, `Ods part ${run}`, 8.25, vendor],
      ],
    },
  ]);

  await owner.goto("/purchasing/catalogue");
  await owner.getByLabel(/The file: a CSV or an .xlsx workbook \(or .ods\)/).setInputFiles({ name: `prices-${run}.ods`, mimeType: ODS, buffer: book });

  const sheets = owner.getByRole("group", { name: "Which sheet to read" });
  await expect(sheets).toBeVisible();
  await expect(sheets.getByRole("radio", { name: /^Prices/ })).toBeChecked();
  await expect(sheets).toContainText("1 row. Columns: sku, description, cost, vendor");
  await expect(sheets.getByRole("radio", { name: /^Cover/ })).toBeDisabled();

  await owner.getByLabel(/Price new parts at a margin of/).fill("40");
  await owner.getByLabel(/Add the vendors this file names/).check();
  await owner.getByRole("button", { name: "Preview" }).click();
  const preview = owner.getByRole("form", { name: "Preview" });
  await expect(preview.getByRole("row").filter({ hasText: sku })).toContainText("New item");

  await preview.getByRole("button", { name: "Apply the ticked rows" }).click();
  await expect(preview.getByRole("status")).toContainText("Done: 1 items added");
  expect(errors).toEqual([]);
});

test("an older workbook is still turned away in words, naming .ods as one that works", async ({ owner }) => {
  await owner.goto("/purchasing/catalogue");
  await owner.getByLabel(/The file: a CSV or an .xlsx workbook/).setInputFiles({
    name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  });
  await expect(owner.getByRole("alert").filter({ hasText: "OpenDocument Spreadsheet (.ods)" })).toBeVisible();
});
