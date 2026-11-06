import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A HOLD THAT NAMES THE CUSTOMER
 *
 * The board picks the customer who asked for a can, found by name above the
 * register, and the hold says who it is for on the row, in the history and
 * through the API. Ending it leaves the history naming them.
 */
async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `GET ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the board holds a can for a customer it picks, and says so", async ({ owner }) => {
  const identifier = `H${run.slice(-6)}`;
  const db = createClient();
  let assetId: string;
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.rentable_asset (organization_id, asset_type, identifier, size)
      select id, 'roll_off_container', ${identifier}, '20 yd' from public.organization where slug = 'ridgeline' returning id`);
    assetId = row!.id;
  } finally {
    await db.$close();
  }
  const name = `Slab Pour Sam ${run}`;
  const customerId = await newCustomer(owner, { name });

  await owner.goto("/fleet/containers");
  await owner.getByRole("textbox", { name: "Find a customer to hold a can for" }).fill(name);
  await owner.getByRole("button", { name: "Find", exact: true }).click();
  await expect(owner).toHaveURL(/holdFor=/);
  await expect(owner.getByText(`offers the customers matching "${name}"`)).toBeVisible();

  const register = () => owner.getByRole("table", { name: "The register" }).getByRole("row").filter({ hasText: identifier });
  await register().getByLabel(`Customer ${identifier} is held for`).selectOption(customerId);
  await register().getByLabel(`Who asked for ${identifier} to be held`).fill("Wants this one for Monday's pour");
  await register().getByRole("button", { name: "Hold for a customer" }).click();
  await expect(register()).toContainText(`Held for ${name}`);
  await expect(register()).toContainText("Wants this one for Monday's pour");

  const holds = owner.getByRole("region", { name: "Repairs and holds" });
  await expect(holds.getByRole("listitem").filter({ hasText: identifier })).toContainText(`Held for ${name}`);

  const listed = await api<{ data: { assetId: string; customerId: string | null; customerName: string | null; endsAt: string | null }[] }>(
    owner, `/v1/container-holds?assetId=${assetId}`);
  expect(listed.data[0]).toMatchObject({ customerId, customerName: name, endsAt: null });

  await register().getByRole("button", { name: "End the hold" }).click();
  await expect(register()).not.toContainText(`Held for ${name}`);
  await expect(holds.getByRole("listitem").filter({ hasText: identifier })).toContainText(`Held for ${name}`);
  await expect(holds.getByRole("listitem").filter({ hasText: identifier })).not.toContainText("still running");
});
