import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A FILE THAT TEXTS NOBODY, AND AN INVOICE OF SEVERAL LINES, ON THE SCREENS
 *
 * The owner brings in a customer list with "Do not start automations for
 * what this file brings in" left on, as it starts, and the screen says so;
 * then an invoice file where one invoice is two rows, which loads as one
 * invoice with both lines on it.
 */

function file(rows: string[][]): Buffer {
  const quoted = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
  return Buffer.from(`${quoted.join("\r\n")}\r\n`, "utf8");
}

test("Bring in customers with automations held, then an invoice of two lines as one invoice", async ({ owner, errors }) => {
  const source = `e2e-lines-${run}`;
  const number = String(700_000 + (parseInt(run.slice(-5), 36) % 200_000));

  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Customers/ }).check();
  await expect(owner.getByRole("checkbox", { name: /Do not start automations for what this file brings in/ })).toBeChecked();
  await owner.getByLabel("The file (CSV)").setInputFiles({
    name: `held-${run}.csv`, mimeType: "text/csv",
    buffer: file([["Customer ID", "Name", "Email"], [`L-${run}`, `Lines Customer ${run}`, `lines-${run}@example.com`]]),
  });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `held-${run}.csv` })).toBeVisible();
  await expect(owner.getByText("Automations will not start for anything this file brings in.")).toBeVisible();
  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
  await owner.getByRole("button", { name: "Check all 1 rows" }).click();
  await owner.getByRole("button", { name: "Load 1 customer" }).click();
  await expect(owner.getByText("1 loaded.")).toBeVisible();

  await owner.goto("/settings/imports");
  await owner.getByRole("radio", { name: /^Past invoices/ }).check();
  await owner.getByLabel("The file (CSV)").setInputFiles({
    name: `lines-${run}.csv`, mimeType: "text/csv",
    buffer: file([
      ["Invoice #", "Customer ID", "Invoice Date", "Description", "Qty", "Price Each", "Invoice Total"],
      [number, `L-${run}`, "2022-03-01", "Igniter", "2", "40.00", "125.00"],
      [number, "", "", "Labor", "1", "45.00", ""],
    ]),
  });
  await owner.getByRole("button", { name: "Upload and match the columns" }).click();
  await expect(owner.getByRole("combobox", { name: /^Price Each/ })).toHaveValue("unitPrice");
  await owner.getByLabel("Where these came from").fill(source);
  await owner.getByRole("button", { name: "Save the columns and read every row again" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Every row has been read again" })).toBeVisible();
  await owner.getByRole("button", { name: "Check all 2 rows" }).click();
  await owner.getByRole("button", { name: "Load 2 rows" }).click();
  await expect(owner.getByText("2 loaded.")).toBeVisible();

  const db = createClient();
  try {
    const [invoice] = await db.execute<{ id: string; total: string }>(sql`
      select id, total::text from public.invoice where source_system = ${source} and source_id = ${number}`);
    expect(invoice!.total).toBe("125.0000");
    await owner.goto(`/invoices/${invoice!.id}`);
    await expect(owner.getByText("Igniter").first()).toBeVisible();
    await expect(owner.getByText("Labor").first()).toBeVisible();
    const events = await db.execute<{ held: number }>(sql`
      select count(*)::int as held from public.domain_event e
      join public.customer c on c.id = e.entity_id
      where c.source_system = ${source} and e.name = 'customer.created' and e.import_run_id is not null`);
    expect(events[0]!.held).toBe(1);
  } finally {
    await db.$close();
  }
  expect(errors).toEqual([]);
});
