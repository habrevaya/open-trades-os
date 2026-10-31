import { test, expect, run } from "./fixtures";
import { buildWorkbook } from "../../../packages/api/test/xlsx-builder";

/**
 * A SUPPLIER'S CATALOGUE SENT AS A WORKBOOK
 *
 * The owner picks the .xlsx a supply house sent, is asked which sheet holds the
 * prices, sees what each row would do, and applies it. A workbook with the cover
 * sheet first is not guessed at, and a file that is not a workbook is refused in words.
 */
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("a catalogue workbook: choose the sheet, preview the rows by their spreadsheet row, apply", async ({ owner, errors }) => {
  const vendor = `Sheet Supply ${run}`;
  const sku = `WB${run.slice(-6).toUpperCase()}`;
  const book = await buildWorkbook([
    { name: "Cover", rows: [["Prices effective this month"]] },
    {
      name: "Prices",
      rows: [
        ["sku", "description", "cost", "vendor"],
        [sku, `Workbook part ${run}`, 12.5, vendor],
        [null, null, null, null],
        [`${sku}-X`, "Broken cost", "call us", vendor],
      ],
    },
  ]);

  await owner.goto("/purchasing/catalogue");
  await owner.getByLabel(/The file: a CSV or an .xlsx workbook/).setInputFiles({ name: `prices-${run}.xlsx`, mimeType: XLSX, buffer: book });

  const sheets = owner.getByRole("group", { name: "Which sheet to read" });
  await expect(sheets).toBeVisible();
  await expect(sheets.getByRole("radio", { name: /^Prices/ })).toBeChecked();
  await expect(sheets).toContainText("2 rows. Columns: sku, description, cost, vendor");
  await expect(sheets.getByRole("radio", { name: /^Cover/ })).toBeDisabled();
  await expect(owner.getByLabel(/Or paste it/)).toHaveCount(0);

  await owner.getByLabel(/Price new parts at a margin of/).fill("40");
  await owner.getByLabel(/Add the vendors this file names/).check();
  await owner.getByRole("button", { name: "Preview" }).click();
  const preview = owner.getByRole("form", { name: "Preview" });
  await expect(preview).toContainText("1 new, 0 linked");
  /** The row is numbered as the spreadsheet numbers it: the empty row 3 is left out, the broken one is row 4. */
  await expect(preview).toContainText("Line 4: ");
  await expect(preview.getByRole("row").filter({ hasText: sku })).toContainText("New item");
  await expect(owner.getByTestId("new-vendors")).toContainText(vendor);

  /** A second look at the same file, as a person would after changing an option. */
  await owner.getByLabel(/Price new parts at a margin of/).fill("50");
  await owner.getByLabel(/Add the vendors this file names/).check();
  await owner.getByRole("button", { name: "Preview" }).click();
  await expect(preview.getByRole("row").filter({ hasText: sku })).toContainText("$25.00");

  await preview.getByRole("button", { name: "Apply the ticked rows" }).click();
  await expect(preview.getByRole("status")).toContainText("Done: 1 items added");
  expect(errors).toEqual([]);
});

test("a file that is not a workbook is refused in words, and nothing can be previewed", async ({ owner }) => {
  await owner.goto("/purchasing/catalogue");
  await owner.getByLabel(/The file: a CSV or an .xlsx workbook/).setInputFiles({
    name: "pretend.xlsx", mimeType: XLSX, buffer: Buffer.from("sku,cost\r\nA,1\r\n"),
  });
  await expect(owner.getByRole("alert").filter({ hasText: "That does not look like an .xlsx workbook" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Preview" })).toBeDisabled();
});
