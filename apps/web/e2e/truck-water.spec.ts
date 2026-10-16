import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, companyToday } from "./fixtures";

/**
 * A TRUCK'S FRESH WATER, TYPED BY THE OFFICE
 *
 * Fresh water per stop is a truck's water over its stops, per truck. The
 * driver reads the tank on the phone; the office types or corrects a reading
 * on "Fresh water by truck", the day shows it, a slip of the thumb is refused
 * in words, and a reading on the wrong truck is taken off.
 */

async function aTruck(label: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.company_asset (organization_id, kind, label)
      select id, 'vehicle', ${label} from public.organization where slug = 'ridgeline' returning id`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

test("the office records a truck's fresh water for a day, and takes it off", async ({ owner }) => {
  test.setTimeout(120_000);
  const label = `Wash truck ${run}`;
  const truckId = await aTruck(label);
  const today = companyToday();

  await owner.goto("/fleet");
  await owner.getByRole("link", { name: "Fresh water by truck" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Fresh water by truck" })).toBeVisible();

  const form = owner.getByRole("region", { name: "Record a reading" });
  await form.getByLabel("Truck").selectOption(truckId);
  await form.getByLabel("Day").fill(today);
  await form.getByLabel("Gallons used").fill("41000");
  await form.getByRole("button", { name: "Save the reading" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "more than a truck uses in a day" })).toBeVisible();

  await form.getByLabel("Gallons used").fill("410");
  await form.getByRole("button", { name: "Save the reading" }).click();
  const table = owner.getByRole("table", { name: `Water by day, ${label}` });
  const row = table.getByRole("row").filter({ hasText: today });
  await expect(row).toContainText("410");
  await expect(row).toContainText("The office");

  await row.getByRole("button", { name: "Take off" }).click();
  await expect(owner.getByRole("region", { name: label })).toHaveCount(0);
});
