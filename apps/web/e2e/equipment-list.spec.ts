import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * EVERY UNIT AT EVERY ADDRESS, FILTERED
 *
 * The office puts two boilers of a kind of its own at a new customer's address,
 * one put in long ago with its warranty run out and one put in last year with
 * parts still covered. On Equipment it chooses that kind, then "At least 10
 * years old", then "Still covered": each time the list holds the units that
 * match, each with its address and customer, and a unit opens its own page.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("Equipment: the whole company's register filtered by kind, age and warranty", async ({ owner }) => {
  const kind = `Boiler ${run}`;
  const name = `Register Rae ${run}`;
  const customerId = await newCustomer(owner, {
    name, address: { street: `${run.slice(-4)} Boiler Bend`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const year = new Date().getUTCFullYear();
  await api(owner, "post", "/v1/equipment", {
    propertyId: data[0]!.id, category: kind, tag: `Old ${run}`, installedOn: "2005-04-01", warrantyPartsExpiresOn: "2010-04-01",
  });
  await api(owner, "post", "/v1/equipment", {
    propertyId: data[0]!.id, category: kind, tag: `New ${run}`, installedOn: `${year - 1}-01-15`, warrantyPartsExpiresOn: `${year + 5}-01-15`,
  });

  await owner.goto("/equipment");
  const filters = owner.getByRole("form", { name: "Filter the equipment" });
  await filters.getByLabel("Kind").selectOption(kind);
  await filters.getByRole("button", { name: "Show" }).click();
  const table = owner.getByRole("table", { name: "Equipment" });
  await expect(table.getByRole("row").filter({ hasText: kind })).toHaveCount(2);
  await expect(table.getByRole("row").filter({ hasText: `Old ${run}` })).toContainText(name);

  await filters.getByLabel("At least, years old").fill("10");
  await filters.getByRole("button", { name: "Show" }).click();
  await expect(table.getByRole("row").filter({ hasText: kind })).toHaveCount(1);
  await expect(table.getByRole("row").filter({ hasText: kind })).toContainText(`Old ${run}`);
  await expect(table.getByRole("row").filter({ hasText: kind })).toContainText("Ran out");

  await owner.goto(`/equipment?kind=${encodeURIComponent(kind)}&warranty=covered`);
  const covered = owner.getByRole("table", { name: "Equipment" }).getByRole("row").filter({ hasText: kind });
  await expect(covered).toHaveCount(1);
  await expect(covered).toContainText(`New ${run}`);
  await expect(covered).toContainText("Parts only");

  await covered.getByRole("link", { name: kind }).click();
  await expect(owner).toHaveURL(/\/equipment\/[0-9a-f-]{36}/);
});
