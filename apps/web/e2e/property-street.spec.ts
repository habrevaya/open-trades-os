import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE STREET A HOME IS ON, KEPT APART FROM THE STREET LINE
 *
 * Homes per served street counts distinct streets, and "12 Oak Street" and
 * "14 Oak St" are one street and two strings. The office types the street on
 * the address's page (or picks one already on file in the town), it is said
 * back as typed, and taking it off says it is not recorded.
 */

async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `GET ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the office records the street an address is on, and takes it off", async ({ owner }) => {
  test.setTimeout(120_000);
  const street = `Larkspur ${run.slice(-5)} Lane`;
  const customerId = await newCustomer(owner, {
    name: `Street ${run}`, address: { street: `${run.slice(-4)} Larkspur Ln`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, `/v1/properties?customerId=${customerId}`);

  await owner.goto(`/properties/${data[0]!.id}`);
  const section = owner.getByRole("region", { name: "Street", exact: true });
  await expect(section).toContainText("No street recorded yet.");

  await section.getByLabel("Street name, without the house number").fill(street);
  await section.getByRole("button", { name: "Save street" }).click();
  await expect(section).toContainText(`On ${street}, typed by your office.`);

  /** Read back as the address's street. */
  const property = await api<{ street: string | null; streetSource: string | null }>(owner, `/v1/properties/${data[0]!.id}`);
  expect(property).toMatchObject({ street, streetSource: "typed" });

  await section.getByRole("button", { name: "Take the street off" }).click();
  await expect(section).toContainText("No street recorded yet.");
});
