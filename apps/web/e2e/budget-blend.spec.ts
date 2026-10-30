import { test, expect } from "./fixtures";

/**
 * THE FORECAST AS A BLEND, AND BY MONTH
 *
 * In a year nobody else's spec touches, the owner sets a Revenue line and
 * chooses a blend of the budget and the run rate, reads the blend back in the
 * sentence above the table, and opens the forecast by month. A blend whose
 * parts do not add up to 100 is refused in words. The year is put back to the
 * budget at the end, so a rerun starts from the same place.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR = 2003;

test("the forecast can be a blend, and read month by month", async ({ owner }) => {
  await owner.goto(`/books/budget?year=${YEAR}`);
  const section = owner.getByRole("region", { name: "Set a line" });
  await section.getByLabel("Line").fill("Revenue");
  for (const name of MONTHS) await section.getByLabel(name, { exact: true }).fill("1000");
  await section.getByRole("button", { name: "Save line" }).click();

  const forecast = owner.getByRole("region", { name: "The forecast" });
  await forecast.getByLabel("The months to come").selectOption("blend");
  await forecast.getByLabel("Blend: at their budget (%)").fill("70");
  await forecast.getByLabel("Blend: at the run rate (%)").fill("20");
  await forecast.getByLabel("Blend: shaped (%)").fill("0");
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(forecast.getByRole("alert").filter({ hasText: "add up to 90" })).toBeVisible();

  await forecast.getByLabel("Blend: at the run rate (%)").fill("30");
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(owner.getByText("The forecast is now a blend.")).toBeVisible();
  /** A year that is over is what the books say; the blend is still the year's choice, kept for the record. */
  await expect(owner.getByTestId("budget-forecast-assumption")).toContainText("not a promise");

  const byMonth = owner.getByTestId("budget-forecast-months");
  await byMonth.getByText("The forecast by month").click();
  const table = byMonth.getByRole("table", { name: `Forecast by month, ${YEAR}` });
  await expect(table.getByRole("row").filter({ hasText: "Revenue" })).toBeVisible();
  await expect(byMonth).toContainText("never saved as the budget");

  // Back to the budget.
  await forecast.getByLabel("The months to come").selectOption("budget");
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(owner.getByText("The forecast now uses the budget.")).toBeVisible();
});
