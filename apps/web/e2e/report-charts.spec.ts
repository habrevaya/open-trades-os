import { test, expect } from "./fixtures";

/**
 * A REPORT IS DRAWN, AND THE DRAWING OPENS ITS RECORDS
 *
 * The seeded company has jobs in several states and invoices over several
 * months, so both shapes have something to draw: bars for a report grouped
 * by a category, a line for one grouped by month. Each shape is a link to the
 * records behind it, and the print view carries the same chart.
 */
test("Charts: a category report is drawn as bars that open their records", async ({ owner }) => {
  await owner.goto("/reports/built-in/jobs-by-status");
  const chart = owner.getByRole("img", { name: /Jobs by status: Jobs by status, as bars/ });
  await expect(chart).toBeVisible();
  await chart.locator("a").first().click();
  await expect(owner).toHaveURL(/\/reports\/drill\?/);
  await expect(owner.getByRole("heading", { level: 1, name: /behind Jobs by status/ })).toBeVisible();
});

test("Charts: a monthly report is drawn as a line, switches to columns, and prints with its chart", async ({ owner }) => {
  await owner.goto("/reports/built-in/revenue-by-month");
  await expect(owner.getByRole("img", { name: /as a line/ })).toBeVisible();

  await owner.getByRole("link", { name: "Columns", exact: true }).click();
  await expect(owner).toHaveURL(/chart=columns/);
  await expect(owner.getByRole("img", { name: /as columns/ })).toBeVisible();

  await owner.getByRole("link", { name: "Print or save as PDF" }).click();
  await expect(owner).toHaveURL(/\/reports\/print\?/);
  await expect(owner.getByRole("heading", { level: 1, name: "Revenue by month" })).toBeVisible();
  await expect(owner.getByRole("img", { name: /as columns/ })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Print or save as PDF" })).toBeVisible();
  // No app chrome on the page meant for paper.
  await expect(owner.getByRole("navigation")).toHaveCount(0);
});
