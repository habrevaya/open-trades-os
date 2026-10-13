import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A COMMISSION TWO PEOPLE SHARE, SPLIT AND SETTLED FROM THE SCREEN
 *
 * The owner finds the invoice of a two person job waiting under Shared
 * commission, reads the even split core proposes, changes it to two to one,
 * is asked why, and settles it; the reason is then on the list of what was
 * shared. The plan, the job and the invoice are made through the API, because
 * they are not what is being tested.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a shared commission is worked out, changed with a reason, and settled", async ({ owner }) => {
  const label = `Shared jobs ${run}`;
  const plan = await api<{ id: string }>(owner, "post", "/v1/commissions/plans", {
    label, basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
  });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const [first, second] = [...technicians].sort((a, b) => a.displayName.localeCompare(b.displayName));
  expect(second).toBeDefined();

  const customerId = await newCustomer(owner, {
    name: `Sade Ibe ${run}`, address: { street: `${run.slice(-4)} Split Ln`, city: "Austin", state: "TX", zip: "78704" },
  });
  const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId, propertyId, summary: `Two person changeout ${run}`,
    visit: {
      windowStart: new Date(Date.now() - 4 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
      estimatedDurationMinutes: 240, technicianIds: [first!.id, second!.id],
    },
  });
  const invoice = await api<{ id: string; number: number }>(owner, "post", "/v1/invoices", {
    customerId, jobId: job.id,
    lines: [{ name: "Condenser changeout", quantity: "1", unitPrice: "1000.00", discountAmount: "0", taxable: false }],
  });

  await owner.goto("/payroll/commissions/splits");
  await expect(owner.getByRole("heading", { level: 1, name: "Shared commission" })).toBeVisible();
  const waiting = owner.getByRole("table", { name: "Waiting to be shared" }).getByRole("row").filter({ hasText: `Sade Ibe ${run}` });
  await expect(waiting).toContainText(first!.displayName);
  await waiting.getByRole("link", { name: "Share it" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: /^Commission on invoice / })).toBeVisible();

  // With more than one plan in force, the page asks which one; this invoice is under the one just declared.
  if (await owner.getByLabel("Plan").count()) {
    await owner.getByLabel("Plan").selectOption({ label });
    await owner.getByRole("button", { name: "Work it out" }).click();
  }
  await expect(owner.getByTestId("split-total")).toContainText("$80.00");
  const table = owner.getByRole("table", { name: "Who gets what" });
  await expect(table.getByRole("row").filter({ hasText: first!.displayName })).toContainText("$40.00");
  await expect(table.getByRole("row").filter({ hasText: second!.displayName })).toContainText("$40.00");

  // Two to one: worked out by the same code that settles it, the odd cent to the bigger share.
  await owner.getByLabel(`Share for ${first!.displayName}`).fill("2");
  await owner.getByRole("button", { name: "Work it out" }).click();
  await expect(table.getByRole("row").filter({ hasText: first!.displayName })).toContainText("$53.34");
  await expect(table.getByRole("row").filter({ hasText: second!.displayName })).toContainText("$26.66");

  const settle = owner.getByRole("region", { name: "Settle it" });
  await expect(settle).toContainText("not an even split");
  await settle.getByLabel("Why it is shared this way").fill(`${first!.displayName} sold the system ${run}.`);
  await settle.getByRole("button", { name: "Settle this split" }).click();
  // Settled, the page shows how it was shared and why, where the form was.
  const done = owner.getByRole("region", { name: "How it was shared" });
  await expect(done).toContainText("This commission has been paid out: $80.00 in all.");
  await expect(done).toContainText(`sold the system ${run}.`);
  await expect(done.getByRole("row").filter({ hasText: first!.displayName })).toContainText("$53.34");

  await owner.goto("/payroll/commissions/splits");
  const shared = owner.getByRole("table", { name: "Shared lately" }).getByRole("row").filter({ hasText: `sold the system ${run}` });
  await expect(shared).toContainText("$53.34");
  await expect(shared).toContainText("$26.66");
  await expect(owner.getByRole("table", { name: "Waiting to be shared" }).getByRole("row").filter({ hasText: `Sade Ibe ${run}` }))
    .toHaveCount(0);
  expect(invoice.number).toBeGreaterThan(0);

  // Out of the way of anything else that settles under a single plan.
  await api(owner, "post", "/v1/commissions/plans/deactivate", { id: plan.id });
});
