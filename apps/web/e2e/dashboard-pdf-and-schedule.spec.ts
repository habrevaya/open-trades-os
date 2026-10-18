import { test, expect, run } from "./fixtures";

/**
 * A WHOLE DASHBOARD, TAKEN AWAY OR SENT
 *
 * "Download as PDF" on a dashboard hands over one file of every tile, and
 * "Email on a schedule" opens the schedule form already on that dashboard and
 * on no dates, because a dashboard is sent as it stands.
 */

test("Dashboards: download one as a PDF, and email it on a schedule", async ({ owner }) => {
  await owner.goto("/dashboards/operations");

  const download = owner.waitForEvent("download");
  await owner.getByRole("link", { name: "Download as PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^operations-\d{4}-\d{2}-\d{2}\.pdf$/);

  await owner.getByRole("link", { name: "Email on a schedule" }).click();
  await expect(owner).toHaveURL(/\/reports\/schedules\/new\?report=dashboard%3Aoperations/);
  await expect(owner.getByRole("heading", { name: "Email a dashboard on a schedule" })).toBeVisible();
  await expect(owner.locator('select[name="report"]')).toHaveValue("dashboard:operations");
  await expect(owner.locator('select[name="period"]')).toHaveValue("all");

  const name = `Operations board ${run}`;
  await owner.getByLabel("Name it (optional)").fill(name);
  await owner.getByRole("button", { name: "Schedule it" }).click();
  await expect(owner).toHaveURL(/\/reports\/schedules$/);

  const row = owner.getByRole("listitem", { name });
  await expect(row).toContainText("A dashboard, as one PDF.");
  await expect(row.getByRole("link", { name })).toHaveAttribute("href", "/dashboards/operations");

  // Clean up after ourselves: the schedule list is shared with other specs.
  await row.getByRole("button", { name: `Stop ${name} for good` }).click();
  await expect(owner.getByRole("listitem", { name })).toHaveCount(0);
});
