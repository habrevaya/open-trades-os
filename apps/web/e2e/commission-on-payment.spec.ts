import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { commissions } from "@opentradesos/api/services";
import { eq } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A COMMISSION SETTLES BY ITSELF WHEN ITS INVOICE IS PAID IN FULL
 *
 * The owner turns it on under Commission plans. Two invoices under a plan
 * that pays on what was collected are paid in full; the worker's pass (run
 * here as the worker runs it) settles the one on a job somebody worked, and
 * leaves the one on a job nobody was put on, with why. The screen lists both.
 * The plan, the jobs, the invoices and the payments go through the API,
 * because they are not what is being tested.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function workerPass(invoiceId: string) {
  const db = createClient();
  try {
    const [row] = await db.select({ organizationId: schema.invoice.organizationId })
      .from(schema.invoice).where(eq(schema.invoice.id, invoiceId)).limit(1);
    if (!row) throw new Error(`No invoice ${invoiceId}`);
    return await commissions.settleOnPaymentFor(db, row.organizationId);
  } finally {
    await db.$close();
  }
}

test("a commission settles by itself when its invoice is paid in full, and what it cannot settle is left with why", async ({ owner }) => {
  const label = `Collected ${run}`;
  const plan = await api<{ id: string }>(owner, "post", "/v1/commissions/plans", {
    label, basis: "percent_of_collected", rate: "0.10", note: "Ten per cent of what the customer paid.",
  });
  try {
    /** A plan an earlier run left in force would make the plan for these invoices a person's choice. */
    const { plans } = await api<{ plans: { id: string; active: boolean }[] }>(owner, "get", "/v1/commissions/plans");
    for (const other of plans.filter((p) => p.active && p.id !== plan.id)) {
      await api(owner, "post", "/v1/commissions/plans/deactivate", { id: other.id });
    }
    const { live } = await api<{ live: { id: string }[] }>(owner, "get", "/v1/commissions/standing-shares");
    for (const share of live) await api(owner, "post", `/v1/commissions/standing-shares/${share.id}/end`, {});
    await api(owner, "post", "/v1/commissions/settle-on-payment", { on: false });

    await owner.goto("/payroll/commissions");
    const section = owner.getByRole("region", { name: "When an invoice is paid in full" });
    await expect(section.getByTestId("on-payment")).toContainText("Off.");
    await section.getByRole("button", { name: "Turn it on" }).click();
    await expect(section.getByTestId("on-payment")).toContainText("On since");

    const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
    const [first] = [...technicians].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const names = [`Ida Paid ${run}`, `Jo Nobody ${run}`];
    const invoices: { id: string }[] = [];
    for (const [i, name] of names.entries()) {
      const customerId = await newCustomer(owner, {
        name, address: { street: `${i + 1}${run.slice(-3)} Paid Way`, city: "Austin", state: "TX", zip: "78704" },
      });
      const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
      const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
        customerId, propertyId, summary: `Tune up ${run} ${i}`,
        visit: {
          windowStart: new Date(Date.now() - 4 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
          estimatedDurationMinutes: 240, technicianIds: i === 0 ? [first!.id] : [],
        },
      });
      const invoice = await api<{ id: string }>(owner, "post", "/v1/invoices", {
        customerId, jobId: job.id,
        lines: [{ name: "Tune up", quantity: "1", unitPrice: "1000.00", discountAmount: "0", taxable: false }],
      });
      invoices.push(invoice);
      await api(owner, "post", "/v1/payments", {
        customerId, method: "check", amount: "1000.00", allocations: [{ invoiceId: invoice.id, amount: "1000.00" }],
      });
    }

    const pass = await workerPass(invoices[0]!.id);
    expect(pass.settled.map((s) => s.invoiceId)).toContain(invoices[0]!.id);
    expect(pass.left.map((l) => l.invoiceId)).toContain(invoices[1]!.id);

    await owner.reload();
    const settled = section.getByRole("table", { name: "Settled by itself lately" });
    await expect(settled.getByRole("row").filter({ hasText: names[0]! })).toContainText("$100.00");
    const left = section.getByRole("table", { name: "Left for you" });
    const row = left.getByRole("row").filter({ hasText: names[1]! });
    await expect(row).toContainText("Nobody is on this job's visits");
    await row.getByRole("link", { name: "Settle it" }).click();
    await expect(owner).toHaveURL(new RegExp(`/payroll/commissions/splits/${invoices[1]!.id}$`));
  } finally {
    await api(owner, "post", "/v1/commissions/settle-on-payment", { on: false });
    await api(owner, "post", "/v1/commissions/plans/deactivate", { id: plan.id });
  }
});
