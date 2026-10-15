import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * AN ITEM'S OWN COMMISSION RATE, PAID BY THE COMPANY'S CHOICE
 *
 * The owner chooses on Commission plans that an item's own rate is paid
 * instead of the plan, then opens the commission on an invoice for a water
 * heater with a rate of its own and a line with none, sees what each line pays
 * and why, settles it, and reads the choice it was worked out under. The plan,
 * the item, the job and the invoice are made through the API, because they are
 * not what is being tested. The choice goes back to the plan only at the end,
 * so nothing else that settles a commission meets it.
 *
 *   Water heater   1,000.00 at the item's 10%   100.00 (the plan's 8% would be 80.00)
 *   Haul away        200.00, no rate             16.00 (the plan's 8%)
 *                                               ------
 *                                               116.00
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the company chooses how an item's own rate is paid, and the earning says which", async ({ owner }) => {
  const label = `Item rates ${run}`;
  const plan = await api<{ id: string }>(owner, "post", "/v1/commissions/plans", {
    label, basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
  });
  const item = await api<{ id: string }>(owner, "post", "/v1/pricebook/items", {
    kind: "equipment", code: `WH-${run}`.toUpperCase(), name: `Water heater ${run}`, price: "1000.00", taxable: false,
  });
  await api(owner, "post", `/v1/pricebook/items/${item.id}/revise`, { commissionRate: "0.10" });

  try {
    await owner.goto("/payroll/commissions");
    const choice = owner.getByRole("region", { name: "When an item has its own rate" });
    await expect(choice.getByTestId("item-rule")).toContainText("Now: The plan only.");
    await choice.getByLabel(/The item's rate, where it has one/).check();
    await choice.getByRole("button", { name: "Save the choice" }).click();
    await expect(choice.getByTestId("item-rule")).toContainText("Now: The item's rate, where it has one.");

    const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
    const tech = [...technicians].sort((a, b) => a.displayName.localeCompare(b.displayName))[0]!;
    const customerId = await newCustomer(owner, {
      name: `Ines Varga ${run}`, address: { street: `${run.slice(-4)} Heater Ln`, city: "Austin", state: "TX", zip: "78704" },
    });
    const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
    const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
      customerId, propertyId, summary: `Water heater changeout ${run}`,
      visit: {
        windowStart: new Date(Date.now() - 4 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
        estimatedDurationMinutes: 240, technicianIds: [tech.id],
      },
    });
    const invoice = await api<{ id: string }>(owner, "post", "/v1/invoices", {
      customerId, jobId: job.id,
      lines: [
        { priceBookItemId: item.id, name: `Water heater ${run}`, quantity: "1", unitPrice: "1000.00", discountAmount: "0", taxable: false },
        { name: "Haul away the old tank", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false },
      ],
    });

    await owner.goto(`/payroll/commissions/splits/${invoice.id}?plan=${plan.id}`);
    await expect(owner.getByTestId("split-total")).toContainText("$116.00");
    const rates = owner.getByRole("region", { name: "Items with their own rate" });
    await expect(rates).toContainText("The company's choice for items with their own rate: The item's rate, where it has one.");
    const heater = rates.getByRole("row").filter({ hasText: `Water heater ${run}` });
    await expect(heater).toContainText("10%");
    await expect(heater).toContainText("$80.00");
    await expect(heater).toContainText("$100.00");
    await expect(heater).toContainText("The item's rate");
    await expect(rates.getByRole("row").filter({ hasText: "Haul away the old tank" })).toContainText("$16.00");

    await owner.getByRole("region", { name: "Settle it" }).getByRole("button", { name: "Settle this split" }).click();
    await expect(owner.getByRole("region", { name: "How it was shared" })).toContainText("This commission has been paid out: $116.00 in all.");
    await expect(owner.getByRole("region", { name: "Items with their own rate" }))
      .toContainText("Worked out under the company's choice: The item's rate, where it has one.");

    // The reason is on the earning, where the register and the person's statement read it.
    const register = await api<{ entries: { invoiceId: string; amount: string; itemRule: string; explanation: string }[] }>(
      owner, "get", `/v1/commissions?technicianId=${tech.id}`);
    const earned = register.entries.find((e) => e.invoiceId === invoice.id)!;
    expect(earned).toMatchObject({ amount: "116.0000", itemRule: "item_wins" });
    expect(earned.explanation).toContain(`Water heater ${run}: 10% of $1,000.00 is $100.00, paid instead of the plan's $80.00.`);
  } finally {
    await api(owner, "post", "/v1/commissions/item-rule", { rule: "plan_only" });
    await api(owner, "post", "/v1/commissions/plans/deactivate", { id: plan.id });
  }
});
