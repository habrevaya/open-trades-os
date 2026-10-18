import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A STANDING SHARE OF SHARED COMMISSION, FROM THE SCREEN
 *
 * The owner gives one technician a standing 30% of the commissions they share.
 * A two person job's split then starts with it, settles as proposed without
 * asking why, and says why on what was settled. The owner stops it again at the
 * end, on the screen, so no other spec's split starts anywhere but even. The
 * plan, the job and the invoice are made through the API, because they are not
 * what is being tested.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** Whatever an earlier run left in force is stopped, so this one starts from even splits. */
async function stopAll(page: Page) {
  const { live } = await api<{ live: { id: string }[] }>(page, "get", "/v1/commissions/standing-shares");
  for (const share of live) await api(page, "post", `/v1/commissions/standing-shares/${share.id}/end`, {});
}

test("a standing share proposes the split, which settles as proposed and says why", async ({ owner }) => {
  await stopAll(owner);
  const label = `Standing jobs ${run}`;
  const plan = await api<{ id: string }>(owner, "post", "/v1/commissions/plans", {
    label, basis: "percent_of_revenue", rate: "0.08", note: "Eight per cent of what the job invoiced for.",
  });
  try {
    const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
    const [first, second] = [...technicians].sort((a, b) => a.displayName.localeCompare(b.displayName));
    expect(second).toBeDefined();

    // The standing share, set on the shared commission screen.
    await owner.goto("/payroll/commissions/splits");
    const standing = owner.getByRole("region", { name: "Standing shares" });
    await standing.getByLabel("Who").selectOption({ label: first!.displayName });
    await standing.getByLabel("Their share, in percent").fill("130");
    await standing.getByLabel("Why they always get it").fill(`Sells the systems ${run}`);
    await standing.getByRole("button", { name: "Set standing share" }).click();
    await expect(standing.getByRole("alert").filter({ hasText: "whole percent from 1 to 99" })).toBeVisible();
    await standing.getByLabel("Their share, in percent").fill("30");
    await standing.getByRole("button", { name: "Set standing share" }).click();
    const row = standing.getByRole("table", { name: "Standing shares" }).getByRole("row").filter({ hasText: first!.displayName });
    await expect(row).toContainText("takes 30% of shared commission whenever they are on the job.");
    await expect(row).toContainText(`Sells the systems ${run}`);

    const customerId = await newCustomer(owner, {
      name: `Ines Ola ${run}`, address: { street: `${run.slice(-4)} Standing Rd`, city: "Austin", state: "TX", zip: "78704" },
    });
    const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
    const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
      customerId, propertyId, summary: `Two person install ${run}`,
      visit: {
        windowStart: new Date(Date.now() - 4 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
        estimatedDurationMinutes: 240, technicianIds: [second!.id, first!.id],
      },
    });
    await api(owner, "post", "/v1/invoices", {
      customerId, jobId: job.id,
      lines: [{ name: "System install", quantity: "1", unitPrice: "1000.00", discountAmount: "0", taxable: false }],
    });

    await owner.goto("/payroll/commissions/splits");
    await owner.getByRole("table", { name: "Waiting to be shared" }).getByRole("row").filter({ hasText: `Ines Ola ${run}` })
      .getByRole("link", { name: "Share it" }).click();
    if (await owner.getByLabel("Plan").count()) {
      await owner.getByLabel("Plan").selectOption({ label });
      await owner.getByRole("button", { name: "Work it out" }).click();
    }
    await expect(owner.getByTestId("standing-shares")).toContainText(`${first!.displayName} takes 30% (Sells the systems ${run})`);
    const table = owner.getByRole("table", { name: "Who gets what" });
    await expect(table.getByRole("columnheader", { name: "Proposed" })).toBeVisible();
    await expect(table.getByRole("row").filter({ hasText: first!.displayName })).toContainText("$24.00");
    await expect(table.getByRole("row").filter({ hasText: second!.displayName })).toContainText("$56.00");

    // As proposed, so no reason is asked for.
    const settle = owner.getByRole("region", { name: "Settle it" });
    await expect(settle.getByLabel("Why it is shared this way")).toHaveCount(0);
    await settle.getByRole("button", { name: "Settle this split" }).click();
    const done = owner.getByRole("region", { name: "How it was shared" });
    await expect(done).toContainText(`Standing shares: ${first!.displayName} takes 30%`);
    await expect(done.getByRole("row").filter({ hasText: first!.displayName })).toContainText("$24.00");

    // Stopped on the screen; what was settled stays settled.
    await owner.goto("/payroll/commissions/splits");
    await owner.getByRole("region", { name: "Standing shares" }).getByRole("table", { name: "Standing shares" })
      .getByRole("row").filter({ hasText: first!.displayName }).getByRole("button", { name: "Stop" }).click();
    await expect(owner.getByRole("region", { name: "Standing shares" })).toContainText("Nobody has a standing share. Every split starts even.");
    await expect(owner.getByRole("table", { name: "Shared lately" }).getByRole("row").filter({ hasText: `Sells the systems ${run}` }))
      .toContainText("$24.00");
  } finally {
    await stopAll(owner);
    await api(owner, "post", "/v1/commissions/plans/deactivate", { id: plan.id });
  }
});
