import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * SEVERAL SHARED COMMISSIONS SETTLED AT ONCE, FROM THE SCREEN
 *
 * Two jobs that two people worked wait under Shared commission with the split
 * proposed for each worked out beside it. The owner ticks both and settles
 * them as proposed in one press; both then read as shared lately, each split
 * as proposed. The plan, the jobs and the invoices are made through the API,
 * because they are not what is being tested.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("shared commissions are ticked and settled as proposed in one press", async ({ owner }) => {
  const label = `Batch jobs ${run}`;
  const plan = await api<{ id: string }>(owner, "post", "/v1/commissions/plans", {
    label, basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
  });
  try {
    /** Whatever an earlier run left in force is stopped, so these split evenly. */
    const { live } = await api<{ live: { id: string }[] }>(owner, "get", "/v1/commissions/standing-shares");
    for (const share of live) await api(owner, "post", `/v1/commissions/standing-shares/${share.id}/end`, {});
    const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
    const [first, second] = [...technicians].sort((a, b) => a.displayName.localeCompare(b.displayName));
    expect(second).toBeDefined();

    const names = [`Bo Lind ${run}`, `Cy Moss ${run}`];
    for (const [i, name] of names.entries()) {
      const customerId = await newCustomer(owner, {
        name, address: { street: `${i + 1}${run.slice(-3)} Batch Way`, city: "Austin", state: "TX", zip: "78704" },
      });
      const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
      const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
        customerId, propertyId, summary: `Two person tune up ${run} ${i}`,
        visit: {
          windowStart: new Date(Date.now() - 4 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
          estimatedDurationMinutes: 240, technicianIds: [first!.id, second!.id],
        },
      });
      await api(owner, "post", "/v1/invoices", {
        customerId, jobId: job.id,
        lines: [{ name: "Tune up", quantity: "1", unitPrice: i === 0 ? "1000.00" : "500.00", discountAmount: "0", taxable: false }],
      });
    }

    await owner.goto("/payroll/commissions/splits");
    const waiting = owner.getByRole("table", { name: "Waiting to be shared" });
    for (const name of names) await waiting.getByRole("row").filter({ hasText: name }).getByRole("checkbox").check();
    if (await owner.getByLabel("Plan they are all under").count()) {
      await owner.getByLabel("Plan they are all under").selectOption({ label });
    } else {
      // With one plan in force, the proposal is already worked out beside each invoice.
      await expect(waiting.getByRole("row").filter({ hasText: names[0]! })).toContainText("$40.00");
    }
    await owner.getByRole("button", { name: "Settle the ticked ones as proposed" }).click();
    /**
     * The page says "Settled 2: ..." under the button while anything is still
     * waiting; when these were the last, the list empties instead. Either way
     * they leave the waiting list and are shared lately.
     */
    await expect(waiting.getByRole("row").filter({ hasText: names[0]! })).toHaveCount(0);
    await expect(waiting.getByRole("row").filter({ hasText: names[1]! })).toHaveCount(0);
    const shared = owner.getByRole("table", { name: "Shared lately" });
    await expect(shared.getByRole("row").filter({ hasText: "$40.00" }).first()).toContainText("An even split.");
    await expect(shared.getByRole("row").filter({ hasText: "$20.00" }).first()).toContainText(first!.displayName);
  } finally {
    await api(owner, "post", "/v1/commissions/plans/deactivate", { id: plan.id });
  }
});
