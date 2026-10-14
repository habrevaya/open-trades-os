import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * NOTES AND PAST VISITS FROM A SPREADSHEET, ON THE SCREENS
 *
 * The owner brings in a customer and a finished job, then a file of notes and
 * a file of past visits. The note is on the customer's page on its own day,
 * marked as brought in; the visit is on the job, done, with the technician
 * the file named by email, and the row naming nobody on the board is refused
 * in words.
 */

function file(rows: string[][]): Buffer {
  const quoted = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
  return Buffer.from(`${quoted.join("\r\n")}\r\n`, "utf8");
}

async function bringIn(owner: import("@playwright/test").Page, kind: RegExp, name: string, rows: string[][], source: string, rowCount: number, loadButton: RegExp) {
  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: kind }).check();
  await owner.getByLabel("The file (CSV)").setInputFiles({ name, mimeType: "text/csv", buffer: file(rows) });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
  await owner.getByRole("button", { name: `Check all ${rowCount} rows` }).click();
  await owner.getByRole("button", { name: loadButton }).click();
}

test("Bring in customer notes and past visits, and find them on the customer and the job", async ({ owner }) => {
  const source = `e2e-history-${run}`;
  const number = String(800_000 + (parseInt(run.slice(-5), 36) % 150_000));

  await bringIn(owner, /^Customers/, `people-${run}.csv`, [
    ["Customer ID", "Name", "Street", "City", "State", "Zip"],
    [`H-${run}`, `History Customer ${run}`, "12 Ledger Ln", "Austin", "TX", "78701"],
  ], source, 1, /^Load 1 customer/);
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await bringIn(owner, /^Past jobs/, `jobs-${run}.csv`, [
    ["Job ID", "Job number", "Customer ID", "Summary", "Status", "Finished on"],
    [`HJ-${run}`, number, `H-${run}`, `Boiler service ${run}`, "completed", "2022-02-10"],
  ], source, 1, /^Load 1 job/);
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await bringIn(owner, /^Customer notes/, `notes-${run}.csv`, [
    ["Customer ID", "Date", "Note", "For technician"],
    [`H-${run}`, "2022-02-09", `Keys are under the mat ${run}`, "yes"],
  ], source, 1, /^Load 1 note/);
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await bringIn(owner, /^Past visits/, `visits-${run}.csv`, [
    ["Job ID", "Technician email", "Visit date", "Start time", "End time", "Notes"],
    [`HJ-${run}`, "nia@ridgeline.example", "2022-02-10", "8:00 AM", "10:00 AM", `Bled the radiators ${run}`],
    [`HJ-${run}`, `nobody-${run}@ridgeline.example`, "2022-02-10", "13:00", "", ""],
  ], source, 2, /^Load 1 visit/);
  await expect(owner.getByText("1 loaded.")).toBeVisible();
  await expect(owner.getByText(`Nobody on the board signs in with nobody-${run}@ridgeline.example`)).toBeVisible();

  const db = createClient();
  try {
    const [customer] = await db.execute<{ id: string }>(sql`
      select id from public.customer where source_system = ${source} and source_id = ${`H-${run}`}`);
    await owner.goto(`/customers/${customer!.id}`);
    const notes = owner.getByRole("region", { name: "Notes" });
    const note = notes.getByRole("listitem").filter({ hasText: `Keys are under the mat ${run}` });
    await expect(note).toContainText(`Brought in from ${source}`);
    await expect(note).toContainText("Feb 9");
    await expect(note).toContainText("Technician sees this");

    const [job] = await db.execute<{ id: string }>(sql`
      select id from public.job where source_system = ${source} and source_id = ${`HJ-${run}`}`);
    await owner.goto(`/jobs/${job!.id}`);
    await expect(owner.getByRole("table").filter({ hasText: "Nia Osei" }).first()).toBeVisible();
  } finally {
    await db.$close();
  }
});
