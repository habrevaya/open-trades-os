import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A TILE BROKEN DOWN, AND THE RECORDS BEHIND A NUMBER PAST A THOUSAND
 *
 * Two things a dashboard and a drill could not do. A tile could draw one
 * grouping only; now a tile on a report grouped by two things is cut by the
 * second, stacked or side by side, by the same chart a report screen draws.
 * And the records behind a number stopped at a thousand; now they go on, a
 * thousand to a page, with the totals over every one on every page.
 */

test("Dashboards: a tile is broken down by its report's second grouping, and a part opens its records", async ({ owner }) => {
  // The one that ships: open jobs by type, stacked by status.
  await owner.goto("/dashboards/operations");
  const shipped = owner.locator("section", { has: owner.getByRole("heading", { name: "Open jobs by type" }) });
  await expect(shipped.getByRole("img", { name: /Job type and status|by job type and status/i })).toBeVisible();
  await expect(shipped.getByRole("list", { name: "Status, by colour" })).toBeVisible();

  // One somebody adds: visits by technician, stacked by status.
  await owner.goto("/dashboards/new");
  await owner.getByLabel("Name").fill(`Crew board ${run}`);
  await owner.getByRole("button", { name: "Create it" }).click();
  await expect(owner).toHaveURL(/\/dashboards\/saved\//);

  // Each label wraps its select, so its name carries the options' words too: picked by field name.
  await owner.locator('select[name="report"]').selectOption({ label: "Visits by technician" });
  await owner.locator('select[name="kind"]').selectOption("bars");
  await owner.locator('select[name="breakdown"]').selectOption("stacked");
  await owner.getByRole("button", { name: "Add it" }).click();

  const tile = owner.locator("section", { has: owner.getByRole("heading", { name: "Visits by technician" }) });
  const chart = tile.getByRole("img", { name: /by technician and status, as stacked bars/ });
  await expect(chart).toBeVisible();
  await expect(tile.getByRole("list", { name: "Status, by colour" })).toBeVisible();

  // Read as a table, the parts and the total of each bar.
  await tile.getByText("View as a table").click();
  await expect(tile.getByRole("columnheader", { name: "Total" })).toBeVisible();

  // A part opens the records of that technician at that status: both are pinned.
  await chart.locator("a").nth(1).click();
  await expect(owner).toHaveURL(/\/reports\/drill\?.*pin=technician.*pin=status/);
  await expect(owner.getByRole("list", { name: "What this row is" })).toContainText("Status:");
});

test("Drill through: past a thousand records the list goes on by pages, and every page totals the whole", async ({ owner }) => {
  /**
   * A thousand and three done tasks in a queue of their own, written straight
   * into the seeded company: the count is the point, not how each was raised,
   * and done tasks in a queue nobody else reads leave the other specs' screens
   * as they were.
   */
  const queue = `Pages ${run}`;
  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.task (organization_id, title, status, queue)
      select o.id, 'Paged task ' || n, 'done', ${queue}
      from public.organization o, generate_series(1, 1003) as n
      where o.slug = 'ridgeline'`);
  } finally {
    await db.$close();
  }

  const query = new URLSearchParams({
    dataset: "tasks", dimensions: "queue", measures: "count", pin: `queue:${queue}`,
    title: "Tasks by queue", back: "/reports",
  });
  await owner.goto(`/reports/drill?${query.toString()}`);
  await expect(owner.getByRole("heading", { level: 1, name: "Tasks behind Tasks by queue" })).toBeVisible();

  const pages = owner.getByRole("navigation", { name: "Pages" });
  await expect(pages).toContainText("1 to 1,000 of 1,003 tasks. The totals are for all 1,003.");
  await expect(pages).toContainText("Page 1 of 2");
  await expect(owner.getByRole("row", { name: "Total", exact: true })).toContainText("1,003");

  await pages.getByRole("link", { name: "Next page" }).click();
  await expect(owner).toHaveURL(/page=2/);
  await expect(pages).toContainText("1,001 to 1,003 of 1,003 tasks");
  await expect(owner.getByRole("table").getByRole("link", { name: /^Paged task \d+$/ })).toHaveCount(3);
  // The total is still the number that was clicked, not this page's three.
  await expect(owner.getByRole("row", { name: "Total", exact: true })).toContainText("1,003");

  await pages.getByRole("link", { name: "Previous page" }).click();
  await expect(owner).not.toHaveURL(/page=/);
  await expect(pages).toContainText("Page 1 of 2");
});
