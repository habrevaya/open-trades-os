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

/** The seeded technician's own id: the first technician the seed made. */
async function seededTechnician(): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      select t.id from public.technician t
      join public.organization o on o.id = t.organization_id
      where o.slug = 'ridgeline' order by t.created_at, t.id limit 1`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

async function handOver(assetId: string, technicianId: string, from: string): Promise<() => Promise<void>> {
  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.asset_custody (organization_id, asset_id, custodian_kind, custodian_id, held_from)
      select organization_id, id, 'technician', ${technicianId}, ${from} from public.company_asset where id = ${assetId}`);
  } finally {
    await db.$close();
  }
  return async () => {
    const end = createClient();
    try {
      await end.execute(sql`delete from public.company_asset where id = ${assetId}`);
    } finally {
      await end.$close();
    }
  };
}

test("a driver reads the truck's fresh water on their day, and it reaches the office", async ({ tech, owner }) => {
  test.setTimeout(180_000);
  const label = `Route truck ${run}`;
  const truckId = await aTruck(label);
  const today = companyToday();
  const done = await handOver(truckId, await seededTechnician(), today);
  try {
    await tech.goto("/my-day");
    const card = tech.getByRole("region", { name: `Fresh water, ${label}` });
    await expect(card).toContainText("Not recorded yet.");
    await card.getByLabel("Gallons used today").fill("about four hundred");
    await card.getByRole("button", { name: "Save the reading" }).click();
    await expect(card.getByRole("alert").filter({ hasText: "as a number" })).toBeVisible();
    await card.getByLabel("Gallons used today").fill("395");
    await card.getByRole("button", { name: "Save the reading" }).click();
    await expect(card).toContainText("395 gallons recorded");

    /** The office sees it on the truck's day, read on the driver's phone. */
    await expect(async () => {
      await owner.goto(`/fleet/water?truck=${truckId}`);
      const row = owner.getByRole("table", { name: `Water by day, ${label}` }).getByRole("row").filter({ hasText: today });
      await expect(row).toContainText("395", { timeout: 2_000 });
      await expect(row).toContainText("The driver's phone", { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
  } finally {
    await done();
  }
});
