import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A UNIT'S DETAILS HELD TO WHAT THE TRADE DECLARES
 *
 * A trade pack declares what a kind of unit carries (a condenser's tonnage, a
 * service panel's rating and open spaces), each with a kind, and the register
 * now holds a unit's details to it. The panel upgrade pipeline reads only
 * details that are their kind. On the unit's page the office is told what the
 * trade reads, refused a value that is not its kind, and shown a detail typed
 * before the register checked it as not read until fixed.
 */

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a condenser's details are held to the kinds the trade declares", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Typed Details ${run}`, address: { street: `${run.slice(-4)} Coil Ct`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  /** Through the API, by label, and stored as its kinds. */
  const made = await api<{ id: string }>(owner, "post", "/v1/equipment", {
    propertyId: data[0]!.id, category: "condenser", attributes: { Tonnage: "3.0", SEER2: "16" },
  });
  const stored = await api<{ attributes: Record<string, unknown> }>(owner, "get", `/v1/equipment/${made.id}`);
  expect(stored.attributes).toEqual({ tonnage: "3.0", seer: 16 });

  await owner.goto(`/equipment/${made.id}`);
  await owner.getByText("Correct its details").click();
  await expect(owner.getByText(/For this kind of unit your trade reads: Tonnage \(one of 1\.5/)).toBeVisible();
  await owner.getByLabel("Other details, one a line").fill("tonnage: 3.0\nseer: sixteen");
  await owner.getByRole("button", { name: "Save details" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: 'SEER2 is a number. "sixteen" is not one.' })).toBeVisible();

  await owner.getByLabel("Other details, one a line").fill("tonnage: 3.0\nseer: 18");
  await owner.getByRole("button", { name: "Save details" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "is a number" })).toHaveCount(0);
  const saved = await api<{ attributes: Record<string, unknown> }>(owner, "get", `/v1/equipment/${made.id}`);
  expect(saved.attributes).toEqual({ tonnage: "3.0", seer: 18 });
});
