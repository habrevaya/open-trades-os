import { test, expect, run, api } from "./fixtures";

/**
 * PHASE 1'S DEFINITION OF DONE, IN A BROWSER
 *
 * "Create a customer, book a job, complete it, invoice it, take a payment, and
 * see the money in a report that agrees with the ledger to the cent."
 *
 * The customer, their address, booking the job, completing its visit and
 * raising and sending the invoice go through the screens. Recording the
 * payment has no office screen yet, so that goes through the HTTP API as the same
 * signed in owner; every result is then read back off the screens a person
 * would check, which is where a wrong number would be seen.
 */

type Job = { id: string; number: number; status: string; visits: { id: string; status: string }[] };
type Invoice = { id: string; number: number; total: string; balance: string; status: string };

const money = (amount: string) =>
  `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("the owner books a job from a new customer through to paid, and the report agrees with the invoice to the cent", async ({ owner, stranger }) => {
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

  // Invoiced from the job: two lines, one at an odd price, so a rounding slip shows.
  await owner.getByRole("link", { name: "Invoice this job" }).click();
  await expect(owner).toHaveURL(/\/invoices\/new\?job=/);
  await owner.getByLabel("Line 1 description").fill("Diagnostic fee");
  await owner.getByLabel("Line 1 quantity").fill("1");
  await owner.getByLabel("Line 1 unit price").fill("129.00");
  await owner.getByRole("button", { name: "Add a line" }).click();
  await owner.getByLabel("Line 2 description").fill("Dual run capacitor");
  await owner.getByLabel("Line 2 quantity").fill("3");
  await owner.getByLabel("Line 2 unit price").fill("43.37");
  await owner.getByRole("button", { name: "Create invoice" }).click();

  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = owner.url().split("/").pop()!;
  const invoice = await api<Invoice>(owner.request, "GET", `/v1/invoices/${invoiceId}`);
  expect(invoice.total).toBe("259.1100");
  await expect(factOf(owner, "Total")).toHaveText(money(invoice.total));

  /*
    Sent. The seeded company has connected no mail provider, so emailing is
    refused in words and the attempt is recorded rather than lost, which is
    what a company that has not set up email yet would see. The link is then
    handed over instead, and it opens the invoice for somebody holding
    nothing else.
  */
  await owner.getByRole("button", { name: "Email invoice" }).click();
  await expect(owner.getByRole("status")).toContainText("Not sent: No email provider is connected");
  await owner.getByRole("button", { name: "Get a link instead" }).click();
  const link = owner.getByRole("link", { name: /\/i\// });
  await expect(link).toBeVisible();
  const url = (await link.getAttribute("href"))!;
  await stranger.goto(url);
  await expect(stranger.getByRole("heading", { name: `Invoice #${invoice.number}` })).toBeVisible();
  await expect(stranger.getByText(money(invoice.total)).first()).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("region", { name: "Sent" })).toContainText(`emailed to imogen+${run}@example.test`);
  await expect(owner.getByRole("region", { name: "Sent" })).toContainText("a link handed over");

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
