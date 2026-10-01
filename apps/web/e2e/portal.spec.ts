import { test, expect, run, api } from "./fixtures";

/**
 * THE CUSTOMER'S SIDE
 *
 * PHASE 2's definition of done: a customer approves an estimate without anyone
 * in the office touching it. The office sends it, and from then on it is a
 * stranger's browser holding nothing but the link.
 *
 * The links are followed exactly as the API hands them out, host and all.
 * A link that works only once somebody has rewritten its host by hand is a
 * link that does not work, and every customer gets the unrewritten one.
 */

type Estimate = { id: string; options: { id: string; name: string }[] };
type Invoice = { id: string; number: number; total: string };

async function newCustomer(request: import("@playwright/test").APIRequestContext, name: string) {
  const customer = await api<{ id: string }>(request, "POST", "/v1/customers", {
    type: "residential", name, phone: "512-555-0123", email: `${run}@example.test`,
    property: { address: { line1: "9 Pecan St", city: "Austin", state: "TX", postalCode: "78702", country: "US" } },
  });
  const properties = await api<{ data: { id: string }[] }>(request, "GET", `/v1/properties?customerId=${customer.id}`);
  return { customerId: customer.id, propertyId: properties.data[0]!.id };
}

test("an estimate sent from the office is approved and signed by the customer through the link, who is taken to pay the deposit", async ({ owner, stranger, baseURL }) => {
  const { customerId, propertyId } = await newCustomer(owner.request, `Rosalind Achebe ${run}`);

  const estimate = await api<Estimate>(owner.request, "POST", "/v1/estimates", {
    customerId, propertyId, title: `Replace the condenser ${run}`,
    options: [
      { name: "Repair", lines: [{ name: "Replace compressor contactor", unitPrice: "289.00", taxable: false }] },
      { name: "Replace", isRecommended: true, lines: [{ name: "3 ton condenser, installed", unitPrice: "5480.00", taxable: false }] },
    ],
  });
  await api(owner.request, "POST", "/v1/deposits", { customerId, estimateId: estimate.id, amount: "500.00" });
  const sent = await api<{ approvalUrl: string }>(owner.request, "POST", `/v1/estimates/${estimate.id}/send`, { channel: "link" });

  // The link the customer is given points at this deployment.
  expect(new URL(sent.approvalUrl).origin).toBe(new URL(baseURL!).origin);

  await stranger.goto(sent.approvalUrl);
  await expect(stranger.getByText(`Replace the condenser ${run}`).first()).toBeVisible();
  await stranger.getByRole("button", { name: /^Replace/ }).click();
  await stranger.getByPlaceholder("Type your full name to sign").fill("Rosalind Achebe");
  await stranger.getByRole("button", { name: "Approve Replace" }).click();

  // A deposit is due, so approving lands on the page that takes it.
  await expect(stranger).toHaveURL(/\/pay\/[A-Za-z0-9_-]+$/);
  await expect(stranger.getByRole("heading", { name: "Deposit" })).toBeVisible();
  await expect(stranger.getByText("$500.00").first()).toBeVisible();

  // The office sees it approved, signed by the person who typed their name.
  const after = await api<{ status: string; signerName: string }>(owner.request, "GET", `/v1/estimates/${estimate.id}`);
  expect(after.status).toBe("approved");
  expect(after.signerName).toBe("Rosalind Achebe");

  // And the link is spent: opening it again does not offer a second approval.
  await stranger.goto(sent.approvalUrl);
  await expect(stranger.getByRole("button", { name: "Approve Replace" })).toHaveCount(0);
});

test("a customer opens their invoice, their account and the seeded proposal and tracking links without signing in", async ({ owner, stranger, seed, baseURL }) => {
  const { customerId } = await newCustomer(owner.request, `Tobias Lindqvist ${run}`);
  const invoice = await api<Invoice>(owner.request, "POST", "/v1/invoices", {
    customerId,
    lines: [{ name: "Annual furnace tune up", quantity: "1", unitPrice: "149.00", discountAmount: "0", taxable: false }],
  });

  const forInvoice = await api<{ url: string }>(owner.request, "POST", "/v1/portal/grants", {
    customerId, scope: "invoice", subjectId: invoice.id,
  });
  const forAccount = await api<{ url: string }>(owner.request, "POST", "/v1/portal/grants", {
    customerId, scope: "customer",
  });
  for (const url of [forInvoice.url, forAccount.url]) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
  }

  const invoicePage = await stranger.goto(forInvoice.url);
  expect(invoicePage?.status()).toBe(200);
  expect(new URL(stranger.url()).pathname).toMatch(/^\/i\//);
  await expect(stranger.getByRole("heading", { name: `Invoice #${invoice.number}` })).toBeVisible();
  await expect(stranger.getByText("$149.00").first()).toBeVisible();

  const accountPage = await stranger.goto(forAccount.url);
  expect(accountPage?.status()).toBe(200);
  expect(new URL(stranger.url()).pathname).toMatch(/^\/c\//);
  await expect(stranger.getByRole("heading", { level: 1, name: `Tobias Lindqvist ${run}` })).toBeVisible();
  await expect(stranger.getByText(`#${invoice.number}`).first()).toBeVisible();

  // The two links the seed prints.
  const proposal = await stranger.goto(seed.proposal);
  expect(proposal?.status()).toBe(200);
  await expect(stranger.getByRole("button").first()).toBeVisible();

  const tracking = await stranger.goto(seed.tracking);
  expect(tracking?.status()).toBe(200);
  await expect(stranger.locator("h1").first()).toBeVisible();

  // A made up token is a page that says so, not a crash.
  const bogus = await stranger.goto("/i/not-a-real-token");
  expect(bogus?.status()).toBeLessThan(500);
});
