import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * FORGETTING A FILE, ON THE SCREENS
 *
 * An uploaded file stays on the list so the screen can show what happened. An
 * owner can forget one, and the screen says which kind of forgetting it is:
 * a file that was never run takes nothing with it, and a file that was run
 * leaves every record it made where it is.
 */

const csv = (rows: string[][]): Buffer => Buffer.from(`${rows.map((r) => r.join(",")).join("\r\n")}\r\n`, "utf8");

async function upload(owner: import("@playwright/test").Page, name: string, source: string, rows: string[][]) {
  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await owner.getByLabel("The file (CSV) or workbook (.xlsx)").setInputFiles({ name, mimeType: "text/csv", buffer: csv(rows) });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
}

test("Forget a file that was never run, and one that was", async ({ owner, errors }) => {
  const source = `e2e-forget-${run}`;
  const db = createClient();

  /** Never run: checked, not loaded. */
  const idle = `idle-${run}.csv`;
  await upload(owner, idle, source, [["Customer ID", "Name"], [`I-${run}`, `Idle Ida ${run}`], [`J-${run}`, `Idle Jo ${run}`]]);
  await owner.getByRole("button", { name: "Check all 2 rows" }).click();
  await expect(owner.getByRole("button", { name: "Load 2 customers" })).toBeVisible();

  const forgetting = owner.getByRole("region", { name: "Forget this file" });
  await expect(forgetting).toContainText("This file has not been run, so nothing from it is in your books.");
  await forgetting.getByRole("button", { name: "Forget this file" }).click();
  /** The box has to be ticked first: the page does not forget on a stray press. */
  await expect(owner.getByRole("heading", { level: 1, name: idle })).toBeVisible();
  await forgetting.getByLabel("Yes, forget this file").check();
  await forgetting.getByRole("button", { name: "Forget this file" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "File forgotten. Nothing had been loaded from it." })).toBeVisible();
  await expect(owner.getByRole("table", { name: "Files brought in" }).filter({ hasText: idle })).toHaveCount(0);
  const none = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.import_run where file_name = ${idle}`);
  expect(Number(none[0]!.n)).toBe(0);

  /** Run: loaded. */
  const done = `done-${run}.csv`;
  await upload(owner, done, source, [["Customer ID", "Name"], [`K-${run}`, `Done Kay ${run}`], [`L-${run}`, `Done Lee ${run}`]]);
  await owner.getByRole("button", { name: "Check all 2 rows" }).click();
  await owner.getByRole("button", { name: "Load 2 customers" }).click();
  await expect(owner.getByText("2 loaded.")).toBeVisible();

  const after = owner.getByRole("region", { name: "Forget this file" });
  await expect(after).toContainText("This file has been run. The 2 records it made stay exactly as they are.");
  await after.getByLabel("Yes, forget this file").check();
  await after.getByRole("button", { name: "Forget this file" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "File forgotten. The 2 records it made are still here." })).toBeVisible();
  const stay = await db.execute<{ name: string }>(sql`select name from public.customer where source_system = ${source} order by source_id`);
  expect(stay.map((r) => r.name)).toEqual([`Done Kay ${run}`, `Done Lee ${run}`]);
  expect(errors).toEqual([]);
});
