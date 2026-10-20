import { test, expect, run, companyToday } from "./fixtures";

/**
 * ONE JOB TYPE'S BUDGET IN ONE BRANCH, AND A FORECAST SHAPED LIKE LAST YEAR
 *
 * The owner picks a branch and a job type together and gets that job type's
 * budget in that branch, a line of its own, with the page saying what it
 * cannot hold. Shaping a year like the one before is refused in words when
 * the books do not hold the whole of the year before; the year asked is one
 * long before this company's books start, so the answer does not depend on
 * what other specs posted.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

test("a branch and a job type together are one budget, and a year is shaped like the last only with that year in the books", async ({ owner }) => {
  const branchName = `Leander ${run}`;
  const branch = await owner.request.post("/api/v1/business-units", { data: { name: branchName } });
  expect(branch.ok()).toBe(true);
  const types = await owner.request.get("/api/v1/job-types");
  const type = (await types.json() as { data: { id: string; name: string }[] }).data[0]!;

  const [year, month] = companyToday().split("-").map(Number) as [number, number];
  await owner.goto(`/books/budget?year=${year}`);
  await owner.getByLabel("Branch").selectOption({ label: branchName });
  await owner.getByLabel("Job type").selectOption({ label: type.name });
  await owner.getByRole("button", { name: "Show" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Budget ${year}, ${type.name} in ${branchName}` })).toBeVisible();
  await expect(owner.getByTestId("budget-branch-job-type-coverage")).toContainText("It is its own budget");

  const section = owner.getByRole("region", { name: "Set a line" });
  await section.getByLabel("Line").fill("Revenue");
  await section.getByLabel(MONTHS[month - 1]!, { exact: true }).fill("4321");
  await section.getByRole("button", { name: "Save line" }).click();
  await expect(owner.getByRole("table").getByText("Revenue").first()).toBeVisible();
  /** The branch's own budget has nothing of it. */
  await owner.goto(`/books/budget?year=${year}&branch=${(await branch.json() as { id: string }).id}`);
  await expect(owner.getByText(`No budget for ${year} for ${branchName} yet`)).toBeVisible();

  await owner.goto("/books/budget?year=2001");
  const forecast = owner.getByRole("region", { name: "The forecast" });
  await forecast.getByLabel("The months to come").selectOption({ label: "Shaped like last year" });
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(forecast.getByRole("alert").filter({ hasText: "needs all of 2000 in your books" })).toBeVisible();
});
