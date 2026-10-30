import { test, expect } from "./fixtures";

/**
 * OVERHEAD BY MATERIAL COST, BY THE VISIT AND BY THE TRUCK
 *
 * The owner sets overhead from a day far in the future as the three later
 * parts only, so nothing any other spec reads today changes, and reads the
 * three rows back as scheduled, each with its basis in words. Sending the
 * same mix for the same day again is a retry, so a rerun passes.
 */
test("overhead can be set by material cost, per visit and per truck day", async ({ owner }) => {
  await owner.goto("/settings/costing");
  const form = owner.getByRole("region", { name: "Overhead from a date" });
  await form.getByLabel("Per paid hour ($)").fill("");
  await form.getByLabel("Per job ($)").fill("");
  await form.getByLabel("Share of revenue (%)").fill("");
  await form.getByLabel("Share of material cost (%)").fill("4");
  await form.getByLabel("Per visit ($)").fill("15");
  await form.getByLabel("Per truck day ($)").fill("40");
  await form.getByLabel("From").fill("2099-01-04");
  await form.getByRole("button", { name: "Set overhead" }).click();
  await expect(form.getByRole("status")).toContainText("Overhead set from 2099-01-04.");

  const table = owner.getByRole("table", { name: "Costing rates" });
  const scheduled = table.getByRole("row").filter({ hasText: "Scheduled" });
  await expect(scheduled.filter({ hasText: "Percent of the job's material cost" })).toContainText("4%");
  await expect(scheduled.filter({ hasText: "Per visit" })).toContainText("$15.00");
  await expect(scheduled.filter({ hasText: "Per truck, each day it went out on the job" })).toContainText("$40.00");
});
