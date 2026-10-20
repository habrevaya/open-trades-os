import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * WHAT A FACILITY TAKES, WHAT IS IN A CAN, AND A CAN THAT CAME BACK EMPTY
 *
 * A facility lists the materials it takes, each with its own price when it has
 * one, so the day plan sends a full can only where it is taken. The board says
 * what is in a can, and a can collected with nothing in it is marked as having
 * come back empty, with the time, so its turnaround is measured from then.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function aContainer(identifier: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string }>(sql`
      insert into public.rentable_asset (organization_id, asset_type, identifier, size)
      select id, 'roll_off_container', ${identifier}, '20 yd' from public.organization where slug = 'ridgeline' returning id`);
    return row!.id;
  } finally {
    await db.$close();
  }
}

const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

test("Disposal facilities: what a facility takes is listed with its prices, and refused in words when a line cannot be read", async ({ owner }) => {
  const name = `Green Pit ${run}`;
  await owner.goto("/fleet/containers/facilities");

  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add facility" }) });
  await add.getByLabel("Name").fill(name);
  await add.getByLabel("Materials it takes").fill("Yard waste, 38.00 a ton\nConcrete, 120 a load\nMetal");
  await add.getByRole("button", { name: "Add facility" }).click();

  const card = owner.getByRole("listitem", { name });
  await expect(card).toContainText("Takes Yard waste, 38.00 a ton; Concrete, 120.00 a load; Metal.");

  const change = card.locator("form").filter({ has: owner.getByRole("button", { name: "Save changes" }) });
  await change.getByLabel("Materials it takes").fill("Tyres, 4 each");
  await change.getByRole("button", { name: "Save changes" }).click();
  await expect(change.getByRole("alert").filter({ hasText: "is not a material and a rate" })).toBeVisible();

  await change.getByLabel("Materials it takes").fill("");
  await change.getByRole("button", { name: "Save changes" }).click();
  await expect(card).toContainText("What it takes is not recorded.");
});

test("Containers: the board says what is in a can, and a can collected empty is marked so with the time", async ({ owner }) => {
  test.setTimeout(180_000);
  const identifier = `E${run.slice(-6)}`;
  const assetId = await aContainer(identifier);
  const customerId = await newCustomer(owner, {
    name: `Empty can ${run.slice(-4)}`, address: { street: `${run.slice(-4)} Empty Ln`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const yesterday = dayBefore(companyToday());
  const hire = await api<{ id: string; materialType: string | null }>(owner, "post", "/v1/rentals", {
    assetId, propertyId: data[0]!.id, deliveredOn: yesterday, materialType: "Yard waste",
  });
  expect(hire.materialType).toBe("Yard waste");

  await owner.goto("/fleet/containers");
  /**
   * The hire's row, found by the can in its first cell: another hire's "Empty
   * can" list names every can in the yard, so a row that merely mentions the
   * number can be somebody else's.
   */
  const hireOf = () => owner.getByRole("table", { name: "Out on hire" }).getByRole("row")
    .filter({ has: owner.locator("td:first-child .font-mono", { hasText: new RegExp(`^${identifier}$`) }) });
  let row = hireOf();
  await expect(row).toContainText("Yard waste");
  await row.getByLabel(`What is in ${identifier}`).fill("Concrete");
  await row.getByRole("button", { name: "Save what is in it" }).click();
  row = hireOf();
  await expect(row).toContainText("Concrete");

  /** Collected today with nothing in it. */
  await api(owner, "post", `/v1/rentals/${hire.id}/pickup`, {});
  await owner.reload();
  row = hireOf();
  await expect(row).toContainText("No ticket");
  await row.getByLabel(`Collected empty at, on ${companyToday()}`).fill("00:01");
  await row.getByRole("button", { name: "Came back empty" }).click();
  row = hireOf();
  await expect(row).toContainText("Came back empty");
  await expect(row.getByRole("button", { name: "Save time emptied" })).toHaveCount(0);

  /** A mistake is taken back, and the row asks for the time emptied again. */
  await row.getByRole("button", { name: "It was not empty" }).click();
  row = hireOf();
  await expect(row).toContainText("No ticket");
  await expect(row.getByRole("button", { name: "Save time emptied" })).toBeVisible();
});
