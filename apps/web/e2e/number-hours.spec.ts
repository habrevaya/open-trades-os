import { createClient, schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";

/**
 * A PHONE NUMBER WITH HOURS OF ITS OWN
 *
 * An emergency line answered here and routed by hours. From its row on
 * Settings the office opens its hours, gives it a week of its own open every
 * day, and a day off of its own; the page says its calls now go by its own
 * hours. Then it is put back on the company's hours, and its own are kept.
 */

/** A number answered here, as a purchase leaves it, written straight in so no carrier is needed. */
async function routedNumber(label: string): Promise<string> {
  const db = createClient();
  try {
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    const digits = String(Date.now()).slice(-7);
    const [row] = await db.insert(schema.phoneNumber).values({
      organizationId: org!.id, e164: `+1737${digits}`, label, purpose: "main", providerNumberId: `PN${digits}`,
      forwardsToE164: "+15125550143", routeByHours: true,
    }).returning({ id: schema.phoneNumber.id });
    return row!.id;
  } finally {
    await db.$close();
  }
}

async function release(id: string): Promise<void> {
  const db = createClient();
  try {
    await db.update(schema.phoneNumber).set({ releasedAt: new Date() }).where(eq(schema.phoneNumber.id, id));
  } finally {
    await db.$close();
  }
}

test("an emergency line given its own hours and a day off of its own, then put back on the company's", async ({ owner }) => {
  const label = `Emergency line ${run}`;
  const id = await routedNumber(label);
  try {
    await owner.goto("/settings");
    const row = owner.getByRole("listitem").filter({ hasText: label });
    await row.getByRole("link", { name: "Its hours and days off" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: "Hours for this number" })).toBeVisible();

    for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
      await owner.getByLabel(`${day} closed`).uncheck();
      await owner.getByLabel(`${day} opens`).fill("00:00");
      await owner.getByLabel(`${day} closes`).fill("23:59");
    }
    await owner.getByRole("button", { name: "Save its own hours" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await owner.reload();
    await expect(owner.locator("section").first()).toContainText("Its own hours");
    await expect(owner.locator("section").first()).toContainText("Sun 00:00 to 23:59");

    await owner.getByLabel("Name", { exact: true }).fill(`Line maintenance ${run}`);
    await owner.getByLabel("Date", { exact: true }).fill("2031-03-04");
    await owner.getByRole("button", { name: "Add day off" }).click();
    const day = owner.getByRole("row").filter({ hasText: `Line maintenance ${run}` });
    await expect(day).toContainText("Closed");

    await owner.getByLabel("Its hours come from").selectOption({ label: "The company's hours" });
    await owner.getByRole("button", { name: "Save where its hours come from" }).click();
    await expect(owner.locator("section").first()).toContainText("The company's hours");
    await expect(owner.getByText("Kept for when it keeps its own hours again.", { exact: false })).toBeVisible();

    await day.getByRole("button", { name: "Remove" }).click();
    await expect(owner.getByRole("row").filter({ hasText: `Line maintenance ${run}` })).toHaveCount(0);
  } finally {
    await release(id);
  }
});
