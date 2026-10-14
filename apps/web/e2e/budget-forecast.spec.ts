import { test, expect, companyToday } from "./fixtures";

/**
 * OVERHEAD AS A MIX, A JOB TYPE'S BUDGET AND THE YEAR END FORECAST
 *
 * The owner sets overhead as three parts from one form and reads it back in a
 * sentence; then opens one job type's budget, sets its revenue, and reads the
 * forecast beside it with the assumption it rests on, switching it to the run
 * rate and back. The job type is one the seed already has, found through the
 * API, because it is not what is being tested.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

test("overhead is set as a mix of parts, and read back in words", async ({ owner }) => {
  await owner.goto("/settings/costing");
  const form = owner.getByRole("region", { name: "Overhead from a date" });
  await form.getByLabel("Per paid hour ($)").fill("12");
  await form.getByLabel("Per job ($)").fill("25");
  await form.getByLabel("Share of revenue (%)").fill("3");
  await form.getByRole("button", { name: "Set overhead" }).click();
  await expect(owner.getByTestId("overhead-now"))
    .toContainText("$12.00 per paid hour, $25.00 per job and 3% of revenue");
  // Three rows in the table, all in effect today.
  const table = owner.getByRole("table", { name: "Costing rates" });
  await expect(table.getByRole("row").filter({ hasText: "In effect" })).toHaveCount(3);
});

test("a job type's budget carries a year end forecast that says what it assumes", async ({ owner }) => {
  const types = await owner.request.get("/api/v1/job-types");
  expect(types.ok()).toBe(true);
  const type = (await types.json() as { data: { id: string; name: string }[] }).data[0]!;

  const today = companyToday();
  const [year, month] = today.split("-").map(Number) as [number, number];
  await owner.goto(`/books/budget?year=${year}`);
  await owner.getByLabel("Job type").selectOption({ label: type.name });
  await owner.getByRole("button", { name: "Show" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Budget ${year}, ${type.name}` })).toBeVisible();
  await expect(owner.getByTestId("budget-job-type-coverage")).toContainText("on no job");

  const section = owner.getByRole("region", { name: "Set a line" });
  await section.getByLabel("Line").fill("Revenue");
  for (const name of MONTHS) await section.getByLabel(name, { exact: true }).fill("1000");
  await section.getByRole("button", { name: "Save line" }).click();

  const table = owner.getByRole("table", { name: `Budget against actual, ${year}` });
  await expect(table.getByRole("columnheader", { name: "Year end forecast" })).toBeVisible();
  const revenue = table.getByRole("row").filter({ hasText: "Revenue" });
  await expect(revenue.getByTestId("budget-forecast")).toContainText("$12,000.00");
  await expect(owner.getByTestId("budget-forecast-assumption")).toContainText("not a promise");
  await expect(owner.getByTestId("budget-forecast-assumption")).toContainText("at their budget");

  const forecast = owner.getByRole("region", { name: "The forecast" });
  await forecast.getByLabel("The months to come").selectOption("run_rate");
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(owner.getByText("The forecast now uses the run rate.")).toBeVisible();
  await expect(owner.getByTestId("budget-forecast-assumption"))
    .toContainText(month === 1 ? "You chose the run rate" : "average of the months already over");

  // Back to the budget, which is what every other reader of this year expects.
  await forecast.getByLabel("The months to come").selectOption("budget");
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(owner.getByText("The forecast now uses the budget.")).toBeVisible();
});
