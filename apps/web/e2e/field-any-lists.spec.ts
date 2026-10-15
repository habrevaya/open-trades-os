import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * "ANY OF THESE" ON THE JOB LIST, AND THE OTHER LISTS OFFERING IT
 *
 * The job list joined its fields by "and" only. It now has the same link the
 * customer list has: from the second field on, "Show jobs that match any of
 * these" joins them by "or", says so in the sentence above the list and keeps
 * it in the address. The invoice, estimate and people lists offer the same
 * link once two of their fields are applied. The fields are made through the
 * API and taken away again whatever happens.
 */

async function api<T>(page: Page, method: "get" | "post" | "delete", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return (await response.text()) ? response.json() as Promise<T> : (undefined as T);
}

test("the job list can match any of its fields, said in words and kept in the address, and the other lists offer it", async ({ owner, errors }) => {
  const defined: string[] = [];
  const zone = `Zone any ${run}`;
  const permit = `Permit any ${run}`;
  const zoneKey = `zone_any_${run}`;
  const permitKey = `permit_any_${run}`;
  try {
    for (const field of [
      { entityType: "job", key: zoneKey, label: zone, dataType: "select", options: ["North", "South"] },
      { entityType: "job", key: permitKey, label: permit },
      { entityType: "invoice", key: `po_any_${run}`, label: `PO any ${run}` },
      { entityType: "invoice", key: `terms_any_${run}`, label: `Terms any ${run}` },
    ]) {
      defined.push((await api<{ id: string }>(owner, "post", "/v1/custom-fields", field)).id);
    }
    const customerId = await newCustomer(owner, {
      name: `Ivy Anyjob ${run}`, address: { street: `${run.slice(-4)} Anyjob Ln`, city: "Austin", state: "TX", zip: "78703" },
    });
    const { data: places } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
    const propertyId = places[0]!.id;
    const jobs = [
      { summary: `North job ${run}`, values: { [zoneKey]: "North" } },
      { summary: `Permit job ${run}`, values: { [permitKey]: "P-9" } },
      { summary: `South job ${run}`, values: { [zoneKey]: "South" } },
    ];
    for (const [index, job] of jobs.entries()) {
      const made = await owner.request.post("/api/v1/jobs", {
        headers: { "idempotency-key": `field-any-${run}-${index}` },
        data: { customerId, propertyId, summary: job.summary, customFields: job.values },
      });
      expect(made.ok(), await made.text()).toBe(true);
    }
    const listed = (summary: string) => owner.getByRole("row").filter({ hasText: summary });

    const both = new URLSearchParams([["field", zoneKey], ["value", "North"], ["field", permitKey], ["value", "P-9"]]);
    await owner.goto(`/jobs?${both}`);
    await expect(owner.getByText(`Showing jobs whose ${zone} is North, and whose ${permit} contains P-9.`)).toBeVisible();
    await expect(listed(`North job ${run}`)).toHaveCount(0);
    await expect(listed(`Permit job ${run}`)).toHaveCount(0);

    await owner.getByRole("link", { name: "Show jobs that match any of these" }).click();
    await expect(owner.getByText(`Showing jobs whose ${zone} is North, or whose ${permit} contains P-9.`)).toBeVisible();
    await expect(listed(`North job ${run}`)).toBeVisible();
    await expect(listed(`Permit job ${run}`)).toBeVisible();
    await expect(listed(`South job ${run}`)).toHaveCount(0);
    const address = new URL(owner.url());
    expect(address.searchParams.get("fieldmatch")).toBe("any");

    // Searching the list keeps the join: the box carries the fields and "any" along.
    await owner.getByRole("searchbox", { name: "Search jobs" }).fill(`permit ${run}`);
    await owner.getByRole("searchbox", { name: "Search jobs" }).press("Enter");
    await expect(owner.getByText(`Showing jobs whose ${zone} is North, or whose ${permit} contains P-9.`)).toBeVisible();
    await expect(listed(`Permit job ${run}`)).toBeVisible();
    await expect(listed(`North job ${run}`)).toHaveCount(0);

    await owner.goto(address.toString());
    await owner.getByRole("link", { name: "Show only jobs that match all of these" }).click();
    await expect(owner.getByText(`Showing jobs whose ${zone} is North, and whose ${permit} contains P-9.`)).toBeVisible();
    await expect(listed(`North job ${run}`)).toHaveCount(0);

    // The invoice list offers the same choice once two of its fields are applied.
    const invoiceFields = new URLSearchParams([["field", `po_any_${run}`], ["value", "A"], ["field", `terms_any_${run}`], ["value", "B"]]);
    await owner.goto(`/invoices?${invoiceFields}`);
    await expect(owner.getByRole("link", { name: "Show invoices that match any of these" })).toBeVisible();
  } finally {
    for (const id of defined) await owner.request.delete(`/api/v1/custom-fields/${id}?force=true`);
  }
  expect(errors).toEqual([]);
});
