import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/** The tiles as stored, read from the database: the screen keeps the box as it was chosen, so a save is told by what was written. */
async function storedTiles(name: string): Promise<Array<Record<string, unknown>>> {
  const db = createClient();
  try {
    const rows = await db.execute<{ tiles: Array<Record<string, unknown>> }>(sql`
      select tiles from public.dashboard where name = ${name} and deleted_at is null`);
    return rows[0]?.tiles ?? [];
  } finally {
    await db.$close();
  }
}

/**
 * A TILE WITH A SECOND MEASURE, AND A DASHBOARD SENT WITH DATES
 *
 * A trend tile can also draw another measure of its report, and a tile can be
 * set to follow the dates a schedule gives its dashboard. A schedule on a
 * dashboard with no tile that follows dates is refused in words; with one, it
 * is saved and its row says which tiles the days reach.
 */
test("Dashboards: a second measure on a tile, and a schedule that gives the dashboard dates", async ({ owner }) => {
  const board = `Dates board ${run}`;
  await owner.goto("/dashboards/new");
  await owner.getByLabel("Name").fill(board);
  await owner.getByRole("button", { name: "Create it" }).click();
  await expect(owner).toHaveURL(/\/dashboards\/saved\//);
  const boardUrl = owner.url();

  await owner.locator('select[name="report"]').selectOption({ label: "Revenue by month" });
  await owner.locator('select[name="kind"]').selectOption("trend");
  await owner.getByRole("button", { name: "Add it" }).click();

  // A second measure of the same report, from the tile's own control.
  const also = owner.getByLabel("Also draw on Revenue by month");
  await expect(also).toBeVisible();
  await also.selectOption({ label: "Invoices" });
  await owner.getByRole("button", { name: "Change", exact: true }).click();
  await expect.poll(async () => (await storedTiles(board))[0]?.["secondMeasure"]).toBe("count");
  await owner.reload();
  await expect(owner.getByLabel("Also draw on Revenue by month")).toHaveValue("count");

  // Sent with days, no tile follows them yet: the form says so in words.
  await owner.getByRole("link", { name: "Email on a schedule" }).click();
  await owner.locator('select[name="period"]').selectOption("last_7_days");
  await owner.getByLabel("Name it (optional)").fill(board);
  await owner.locator('input[name="userIds"]').first().check();
  await owner.getByRole("button", { name: "Schedule it" }).click();
  await expect(owner.getByText(/None of this dashboard's tiles follow dates/)).toBeVisible();

  // Turn it on for the tile, and the same schedule is taken.
  await owner.goto(boardUrl);
  await owner.getByLabel("Revenue by month follows the dashboard's dates").check();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await storedTiles(board))[0]?.["followsDates"]).toBe(true);
  await owner.reload();
  await expect(owner.getByLabel("Revenue by month follows the dashboard's dates")).toBeChecked();

  await owner.getByRole("link", { name: "Email on a schedule" }).click();
  await owner.locator('select[name="period"]').selectOption("last_7_days");
  await owner.getByLabel("Name it (optional)").fill(board);
  await owner.locator('input[name="userIds"]').first().check();
  await owner.getByRole("button", { name: "Schedule it" }).click();
  await expect(owner).toHaveURL(/\/reports\/schedules$/);

  const row = owner.getByRole("listitem", { name: board });
  await expect(row).toContainText("for the tiles that follow the dashboard's dates");

  // Clean up after ourselves: the schedule list is shared with other specs.
  await row.getByRole("button", { name: `Stop ${board} for good` }).click();
  await expect(owner.getByRole("listitem", { name: board })).toHaveCount(0);
});
