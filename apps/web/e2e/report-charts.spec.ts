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

test("Charts: a report grouped by two things can be cut by the second, stacked or side by side, and a part opens its records", async ({ owner }) => {
  await owner.goto("/reports/new?dataset=jobs&dimensions=status,priority&measures=count");
  // As it was: drawn by the first, with the second added up, and a way to break it down.
  await expect(owner.getByRole("img", { name: /Jobs by status, as bars/ })).toBeVisible();
  await expect(owner.getByText("Added up over priority")).toBeVisible();

  await owner.getByRole("link", { name: "Priority", exact: true }).click();
  await expect(owner).toHaveURL(/split=priority/);
  const stacked = owner.getByRole("img", { name: /Jobs by status and priority, as stacked bars/ });
  await expect(stacked).toBeVisible();
  // What each colour is, in words.
  await expect(owner.getByRole("list", { name: "Priority, by colour" })).toBeVisible();

  // A part opens the records of that status at that priority.
  await stacked.locator("a").first().click();
  await expect(owner).toHaveURL(/\/reports\/drill\?/);
  await owner.goBack();

  await owner.getByRole("link", { name: "Side by side" }).click();
  await expect(owner).toHaveURL(/arrange=grouped/);
  await expect(owner.getByRole("img", { name: /as side by side bars/ })).toBeVisible();

  // And back to adding it up.
  await owner.getByRole("link", { name: "Not broken down" }).click();
  await expect(owner).not.toHaveURL(/split=/);
  await expect(owner.getByText("Added up over priority")).toBeVisible();
});

test("Charts: a dashboard tile is the report chart, and can be read as a table", async ({ owner }) => {
  await owner.goto("/dashboards/money");
  const tile = owner.locator("section", { has: owner.getByRole("heading", { name: "Who owes us" }) });
  await expect(tile.locator("svg").first()).toBeVisible();
  await tile.getByText("View as a table").click();
  await expect(tile.getByRole("table")).toBeVisible();
  await expect(tile.getByRole("row").nth(1)).toBeVisible();
});
