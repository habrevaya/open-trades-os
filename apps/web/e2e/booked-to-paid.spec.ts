import { test, expect, run, api } from "./fixtures";

/**
 * PHASE 1'S DEFINITION OF DONE, IN A BROWSER
 *
 * "Create a customer, book a job, complete it, invoice it, take a payment, and
 * see the money in a report that agrees with the ledger to the cent."
 *
 * The customer, their address, booking the job and completing its visit go
 * through the screens. Raising the invoice and recording the payment have
 * no office screen yet, so those two go through the HTTP API as the same
 * signed in owner; every result is then read back off the screens a person
 * would check, which is where a wrong number would be seen.
 */

type Job = { id: string; number: number; status: string; visits: { id: string; status: string }[] };
type Invoice = { id: string; number: number; total: string; balance: string; status: string };

const money = (amount: string) =>
  `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("the owner books a job from a new customer through to paid, and the report agrees with the invoice to the cent", async ({ owner }) => {
  const name = `Imogen Hartley ${run}`;

  // The customer and their address, through the form.
  await owner.goto("/customers/new");
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Phone").fill("512-555-0188");
  await owner.getByLabel("Email").fill(`imogen+${run}@example.test`);
  await owner.getByLabel("Street").fill("88 Bluebonnet Ln");
  await owner.getByLabel("City").fill("Austin");
  await owner.getByLabel("State").fill("TX");
  await owner.getByLabel("ZIP").fill("78704");
  await owner.getByRole("button", { name: "Save customer" }).click();

  await expect(owner).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  const customerId = owner.url().split("/").pop()!;
  const address = owner.getByRole("link", { name: "88 Bluebonnet Ln, Austin" });
  await expect(address).toBeVisible();
  const propertyId = (await address.getAttribute("href"))!.split("/").pop()!;
  expect(propertyId).toMatch(/^[0-9a-f-]{36}$/);

  // The property page opens for the address the form created.
  await address.click();
  await expect(owner).toHaveURL(new RegExp(`/properties/${propertyId}$`));
  await expect(owner.getByText("88 Bluebonnet Ln").first()).toBeVisible();

  // Booked, from the customer's address, with its first visit tomorrow morning.
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await expect(owner).toHaveURL(/\/jobs\/new\?customer=/);
  await owner.getByLabel("Summary").fill(`No cooling upstairs ${run}`);
  await owner.getByLabel("Customer said").fill("Clicking, then it stopped blowing cold");
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
  await owner.getByLabel("Arrives from").fill("10:00");
  await owner.getByLabel("Expected to take (minutes)").fill("90");
  await owner.getByRole("button", { name: "Book job" }).click();

  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobId = owner.url().split("/").pop()!;
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(`No cooling upstairs ${run}`);
  await expect(owner.getByRole("table").last()).toContainText(/Unassigned|Scheduled/);
  const job = await api<Job>(owner.request, "GET", `/v1/jobs/${jobId}`);
  expect(job.visits).toHaveLength(1);

  // Completed, from the office, with what was done.
  await owner.getByText("Complete visit 1").first().click();
  await owner.getByLabel("What was done on visit 1").fill("Dual run capacitor failed. Replaced, verified cooling.");
  await owner.getByRole("button", { name: "Complete visit 1" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Completed")).toBeVisible();
  await expect(owner.getByText("Dual run capacitor failed.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Reopen job" })).toBeVisible();

  // Invoiced: one line at an odd price, so a rounding slip shows.
  const invoice = await api<Invoice>(owner.request, "POST", "/v1/invoices", {
    customerId, jobId: job.id,
    lines: [
      { name: "Diagnostic fee", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false },
      { name: "Dual run capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "0", taxable: false },
    ],
  });
  expect(invoice.total).toBe("259.1100");

  await owner.goto(`/invoices/${invoice.id}`);
  await expect(owner.getByText(money(invoice.total)).first()).toBeVisible();

  await owner.goto(`/customers/${customerId}`);
  await expect(balanceOf(owner)).toHaveText(money(invoice.total));

  // Paid in full, by cheque.
  await api(owner.request, "POST", "/v1/payments", {
    customerId, method: "check", amount: "259.11", checkNumber: "1044",
    allocations: [{ invoiceId: invoice.id, amount: "259.11" }],
  });

  await owner.goto(`/invoices/${invoice.id}`);
  await expect(owner.getByText("Paid").first()).toBeVisible();
  await expect(factOf(owner, "Balance")).toHaveText("$0.00");

  await owner.goto(`/customers/${customerId}`);
  await expect(balanceOf(owner)).toHaveText("$0.00");

  /*
    The ledger. Revenue on the job and on the job costing report is read from
    ledger postings, not from the invoice, so these agreeing with the invoice
    total to the cent is the reconciliation the phase promised.
  */
  await owner.goto(`/jobs/${job.id}`);
  const costing = owner.getByRole("region", { name: "Job costing" });
  await expect(costing.getByRole("definition").first()).toHaveText(money(invoice.total));

  await owner.goto("/reports/built-in/job-costing");
  const row = owner.getByRole("row").filter({ hasText: `No cooling upstairs ${run}` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(money(invoice.total));
});

function balanceOf(page: import("@playwright/test").Page) {
  return factOf(page, "Balance");
}

/** The value next to a label in a definition list. */
function factOf(page: import("@playwright/test").Page, label: string) {
  return page.locator(`dt:text-is("${label}") + dd`).first();
}
