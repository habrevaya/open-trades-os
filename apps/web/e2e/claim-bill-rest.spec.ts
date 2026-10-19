import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * WHAT THE WARRANTY COMPANY DID NOT PAY, BILLED TO THE HOMEOWNER
 *
 * A home warranty job's invoice to the warranty company is claimed for
 * $300.00, approved for $250.00 and paid. The claim says the rest cannot be
 * billed while their invoice still shows it owing; once the office writes
 * that off, "Bill the rest to the customer" makes a draft invoice to the
 * homeowner for $50.00 with a line saying what it is, and the claim shows
 * it. The job, the invoice, the claim and its payment go through the API,
 * because they are not what is being tested.
 */
async function api<T>(page: Page, method: "get" | "post" | "put", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the rest of a claim the warranty company paid short is billed to the homeowner as a draft, by a person", async ({ owner }) => {
  const homeownerName = `Rae Homeowner ${run}`;
  const warrantyName = `Bastion Warranty ${run}`;
  const homeowner = await newCustomer(owner, {
    name: homeownerName, address: { street: `9${run.slice(-3)} Claim St`, city: "Austin", state: "TX", zip: "78704" },
  });
  const warranty = await newCustomer(owner, { name: warrantyName });
  const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${homeowner}`)).data[0]!.id;
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId: homeowner, propertyId, summary: `Warranty repair ${run}`,
    visit: {
      windowStart: new Date(Date.now() - 3 * 3_600_000).toISOString(), windowEnd: new Date().toISOString(),
      estimatedDurationMinutes: 120, technicianIds: [],
    },
  });
  await api(owner, "put", `/v1/jobs/${job.id}/coverage`, { source: "home_warranty", externalReference: `BW-${run}` });
  const theirs = await api<{ id: string }>(owner, "post", "/v1/invoices", {
    customerId: warranty, jobId: job.id,
    lines: [{ name: "Compressor replacement", quantity: "1", unitPrice: "300.00", discountAmount: "0", taxable: false }],
  });
  const claim = await api<{ id: string }>(owner, "post", "/v1/claims", { invoiceId: theirs.id, externalReference: `BW-${run}` });
  await api(owner, "post", `/v1/claims/${claim.id}/decision`, { outcome: "approved", amount: "250.00" });
  await api(owner, "post", `/v1/claims/${claim.id}/payments`, { amount: "250.00", method: "check", reference: "5521" });

  await owner.goto(`/invoices/claims/${claim.id}`);
  const rest = owner.getByRole("region", { name: "Bill the rest to the customer" });
  await expect(rest).toContainText("Their invoice still shows $50.00 owing. Credit it or write it off on their invoice first");
  await expect(rest.getByRole("button", { name: "Bill the rest to the customer" })).toHaveCount(0);

  await api(owner, "post", `/v1/invoices/${theirs.id}/write-off`, { reason: "Bastion will not pay past their approval" });
  await owner.reload();
  await expect(rest).toContainText("$50.00");
  await rest.getByRole("button", { name: "Bill the rest to the customer" }).click();

  /** The draft opens, to the homeowner, with one line saying what it is. */
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.getByText(homeownerName).first()).toBeVisible();
  await expect(owner.getByText(`Not paid by ${warrantyName}`).first()).toBeVisible();
  await expect(owner.getByText("This is the rest.").first()).toBeVisible();
  const draftUrl = owner.url();

  await owner.goto(`/invoices/claims/${claim.id}`);
  const billed = owner.getByRole("region", { name: "Billed to the customer" });
  await expect(billed).toContainText("$50.00");
  await expect(billed).toContainText("still a draft");
  await billed.getByRole("link", { name: /invoice/ }).click();
  await expect(owner).toHaveURL(draftUrl);
});
