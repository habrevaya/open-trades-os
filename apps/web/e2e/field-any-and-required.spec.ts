import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * "ANY OF THESE" ON THE CUSTOMER LIST, AND REQUIRED FIELDS WHEN A RECORD IS MADE
 *
 * The customer list joins fields by AND, and a link turns that into "any of
 * these" and back, said in words and carried in the address. And a company's
 * required fields are asked for on the forms that make an invoice, an
 * estimate, a visit and a unit: refused in words when one is left out, saved
 * when it is given. The fields and the people are made through the API,
 * because declaring a field is not what this is about; every form is driven
 * the way the office uses it. Specs run one at a time, and the required
 * fields are taken away again whatever happens, so no other spec meets them.
 */

async function api<T>(page: Page, method: "get" | "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return (await response.text()) ? response.json() as Promise<T> : (undefined as T);
}

test("the customer list can match any of its fields, said in words and kept in the address", async ({ owner }) => {
  const defined: string[] = [];
  const plan = `Plan any ${run}`;
  const pets = `Pets any ${run}`;
  try {
    for (const field of [
      { entityType: "customer", key: `plan_any_${run}`, label: plan, dataType: "select", options: ["Annual", "Monthly"] },
      { entityType: "customer", key: `pets_any_${run}`, label: pets, dataType: "boolean" },
    ]) {
      defined.push((await api<{ id: string }>(owner, "post", "/v1/custom-fields", field)).id);
    }
    const households = [
      { name: `Anna Annual ${run}`, values: { [`plan_any_${run}`]: "Annual", [`pets_any_${run}`]: true } },
      { name: `Alec Annual ${run}`, values: { [`plan_any_${run}`]: "Annual", [`pets_any_${run}`]: false } },
      { name: `Mona Monthly ${run}`, values: { [`plan_any_${run}`]: "Monthly", [`pets_any_${run}`]: true } },
      { name: `Cal Neither ${run}`, values: { [`plan_any_${run}`]: "Monthly", [`pets_any_${run}`]: false } },
    ];
    for (const household of households) {
      await api(owner, "post", "/v1/customers", { type: "residential", name: household.name, customFields: household.values });
    }
    const [anna, alec, mona, cal] = households.map((h) => h.name) as [string, string, string, string];
    const listed = (name: string) => owner.getByRole("row").filter({ hasText: name });

    await owner.goto("/customers");
    const filter = owner.getByRole("form", { name: "Filter by a custom field" });
    await filter.locator("select[name=field]").selectOption({ label: plan });
    await filter.getByLabel("Is").fill("Annual");
    await filter.getByRole("button", { name: "Filter" }).click();
    // One field is the same either way, so no choice is offered yet.
    await expect(owner.getByRole("link", { name: /match any of these/ })).toHaveCount(0);

    await filter.locator("select[name=field]").selectOption({ label: pets });
    await filter.getByLabel("Is").fill("yes");
    await filter.getByRole("button", { name: "Add this filter" }).click();
    await expect(owner.getByText(`Showing customers whose ${plan} is Annual, and whose ${pets} is yes.`)).toBeVisible();
    await expect(listed(anna)).toBeVisible();
    await expect(listed(alec)).toHaveCount(0);
    await expect(listed(mona)).toHaveCount(0);

    // Any of these: the plan OR the pets, said as "or" and kept in the address.
    await owner.getByRole("link", { name: "Show customers that match any of these" }).click();
    await expect(owner.getByText(`Showing customers whose ${plan} is Annual, or whose ${pets} is yes.`)).toBeVisible();
    await expect(listed(anna)).toBeVisible();
    await expect(listed(alec)).toBeVisible();
    await expect(listed(mona)).toBeVisible();
    await expect(listed(cal)).toHaveCount(0);
    const address = new URL(owner.url());
    expect(address.searchParams.get("fieldmatch")).toBe("any");

    // The address is the list: opened fresh it is the same one.
    await owner.goto(address.toString());
    await expect(listed(mona)).toBeVisible();
    await expect(listed(cal)).toHaveCount(0);

    // Adding a third keeps "or", and taking one off down to one drops it, since one is the same either way.
    await owner.getByRole("link", { name: `Stop filtering by ${pets}` }).click();
    await expect(owner.getByText(`Showing customers whose ${plan} is Annual.`)).toBeVisible();
    expect(new URL(owner.url()).searchParams.get("fieldmatch")).toBeNull();
    await expect(listed(mona)).toHaveCount(0);

    // And back to all of them.
    await owner.goto(address.toString());
    await owner.getByRole("link", { name: "Show only customers that match all of these" }).click();
    await expect(owner.getByText(`Showing customers whose ${plan} is Annual, and whose ${pets} is yes.`)).toBeVisible();
    await expect(listed(alec)).toHaveCount(0);
  } finally {
    for (const id of defined) await owner.request.delete(`/api/v1/custom-fields/${id}?force=true`);
  }
});

test("an invoice, an estimate, a visit and a unit each ask for the company's required field when they are made", async ({ owner }) => {
  test.setTimeout(180_000);
  const defined: string[] = [];
  try {
    const customerId = await newCustomer(owner, {
      name: `Rhea Required ${run}`, address: { street: `${run.slice(-4)} Required Rd`, city: "Austin", state: "TX", zip: "78702" },
    });
    const { data: places } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
    const propertyId = places[0]!.id;
    const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId, propertyId, summary: `Required job ${run}` });

    const labels = {
      invoice: `Invoice ref ${run}`, estimate: `Estimate ref ${run}`, visit: `Gate code ${run}`, equipment: `Filter size ${run}`,
    } as const;
    for (const [entityType, label] of Object.entries(labels)) {
      defined.push((await api<{ id: string }>(owner, "post", "/v1/custom-fields", {
        entityType, key: `${entityType}_req_${run}`, label, dataType: "text", required: true,
      })).id);
    }

    /* An invoice. */
    await owner.goto(`/invoices/new?customer=${customerId}`);
    await owner.getByLabel("Line 1 description").fill("Furnace tune up");
    await owner.getByLabel("Line 1 quantity").fill("1");
    await owner.getByLabel("Line 1 unit price").fill("149.00");
    await expect(owner.getByText(`${labels.invoice} (required)`)).toBeVisible();
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: `${labels.invoice} is required.` })).toBeVisible();
    await expect(owner).toHaveURL(/\/invoices\/new/);
    await owner.getByLabel(`${labels.invoice} (required)`).fill("REF-1");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    await expect(owner.getByLabel(labels.invoice)).toHaveValue("REF-1");

    /* An estimate. */
    await owner.goto(`/estimates/new?customer=${customerId}&property=${propertyId}`);
    await owner.getByLabel("Title").fill(`Required estimate ${run}`);
    await owner.getByLabel("Option 1 name").fill("Fix");
    await owner.getByLabel("Description, option 1 line 1").fill("Repair");
    await owner.getByLabel("Unit price, option 1 line 1").fill("300.00");
    await owner.getByRole("button", { name: "Save estimate" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: `${labels.estimate} is required.` })).toBeVisible();
    await owner.getByLabel(`${labels.estimate} (required)`).fill("EST-1");
    await owner.getByRole("button", { name: "Save estimate" }).click();
    await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
    await expect(owner.getByLabel(labels.estimate)).toHaveValue("EST-1");

    /* A visit. */
    await owner.goto(`/jobs/${job.id}`);
    await owner.getByText("Add a visit", { exact: true }).click();
    await owner.getByRole("button", { name: "Add visit" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: `${labels.visit} is required.` })).toBeVisible();
    await owner.getByLabel(`${labels.visit} (required)`).fill("4471");
    await owner.getByRole("button", { name: "Add visit" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "is required." })).toHaveCount(0);
    await expect.poll(async () => {
      const found = await api<{ visits: { id: string }[] }>(owner, "get", `/v1/jobs/${job.id}`);
      return found.visits.length;
    }).toBe(1);

    /* A unit. */
    await owner.goto(`/properties/${propertyId}`);
    await owner.getByRole("button", { name: "Add a unit" }).click();
    await owner.getByLabel("What it is").fill("furnace");
    await owner.getByRole("button", { name: "Add it" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: `${labels.equipment} is required.` })).toBeVisible();
    await owner.getByLabel(`${labels.equipment} (required)`).fill("16x25x1");
    await owner.getByRole("button", { name: "Add it" }).click();
    await expect(owner.getByRole("link", { name: /furnace/ }).first()).toBeVisible();
  } finally {
    for (const id of defined) await owner.request.delete(`/api/v1/custom-fields/${id}?force=true`);
  }
});
