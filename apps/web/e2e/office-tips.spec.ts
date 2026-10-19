import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE OFFICE RECORDS A TIP WITH A CASH PAYMENT
 *
 * A customer pays an invoice at the counter in cash and adds something for
 * the technician. The office records the payment from the invoice with the
 * tip on top; the invoice is paid, and the tip shows under Tips held for the
 * technician by name. Tipping, the job and the invoice are set up through the
 * API, because they are not what is being tested.
 */
async function api<T>(page: Page, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the office records a cash payment with a tip on top, shared to the technician on the job", async ({ owner }) => {
  const before = await api<{ tipping: { enabled: boolean; presets: number[] } }>(owner, "get", "/v1/portal-settings");
  await api(owner, "patch", "/v1/portal-settings", { tipping: { enabled: true, presets: [10, 15, 20] } });
  try {
    const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
    const [tech] = [...technicians].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const name = `Lu Counter ${run}`;
    const customerId = await newCustomer(owner, {
      name, address: { street: `7${run.slice(-3)} Counter Rd`, city: "Austin", state: "TX", zip: "78704" },
    });
    const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
    const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
      customerId, propertyId, summary: `Drain clear ${run}`,
      visit: {
        windowStart: new Date(Date.now() - 3 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
        estimatedDurationMinutes: 120, technicianIds: [tech!.id],
      },
    });
    const invoice = await api<{ id: string }>(owner, "post", "/v1/invoices", {
      customerId, jobId: job.id,
      lines: [{ name: "Drain clear", quantity: "1", unitPrice: "180.00", discountAmount: "0", taxable: false }],
    });

    await owner.goto(`/invoices/${invoice.id}`);
    await owner.getByRole("region", { name: "Take payment" }).getByRole("link", { name: "Record a payment" }).click();
    await expect(owner).toHaveURL(/\/payments\/new\?/);
    await owner.getByLabel("How it was paid").selectOption("cash");
    const firstName = tech!.displayName.trim().split(/\s+/)[0]!;
    /** Too much is refused in the portal's own words, and nothing is recorded. */
    await owner.getByLabel(`Tip on top, for ${firstName}`).fill("500");
    await owner.getByRole("button", { name: "Record payment" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "A tip can be at most the amount being paid, $180.00." })).toBeVisible();

    await owner.getByLabel(`Tip on top, for ${firstName}`).fill("25");
    await owner.getByRole("button", { name: "Record payment" }).click();
    await expect(owner).toHaveURL(new RegExp(`/invoices/${invoice.id}$`));
    await expect(owner.locator('dt:text-is("Balance") + dd').first()).toHaveText("$0.00");
    const tips = owner.getByRole("table", { name: "Tips on this invoice" });
    const row = tips.getByRole("row").filter({ hasText: tech!.displayName });
    await expect(row).toContainText("$25.00");
    await expect(row).toContainText("Not yet");
  } finally {
    await api(owner, "patch", "/v1/portal-settings", { tipping: before.tipping });
  }
});
