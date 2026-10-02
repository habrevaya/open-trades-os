import { test, expect, run } from "./fixtures";

/**
 * THE CUSTOMER'S SIDE
 *
 * PHASE 2's definition of done: a customer approves an estimate without anyone
 * in the office touching it. The office writes and sends it on its screens,
 * and from then on it is a stranger's browser holding nothing but the link.
 *
 * The links are followed exactly as the API hands them out, host and all.
 * A link that works only once somebody has rewritten its host by hand is a
 * link that does not work, and every customer gets the unrewritten one.
 */

test("an estimate written and sent from the office is approved and signed by the customer through the link, who is taken to pay the deposit, and the office converts it into a job", async ({ owner, stranger, baseURL }) => {
  // The customer, through the form.
  const name = `Rosalind Achebe ${run}`;
  await owner.goto("/customers/new");
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Email").fill(`rosalind+${run}@example.test`);
  await owner.getByLabel("Street").fill("9 Pecan St");
  await owner.getByLabel("City").fill("Austin");
  await owner.getByLabel("State").fill("TX");
  await owner.getByLabel("ZIP").fill("78702");
  await owner.getByRole("button", { name: "Save customer" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();

  // Good and better: a repair, or a replacement, which is recommended.
  await owner.getByRole("link", { name: "New estimate" }).click();
  await owner.getByLabel("Title").fill(`Replace the condenser ${run}`);
  await owner.getByLabel("Option 1 name").fill("Repair");
  await owner.getByLabel("Description, option 1 line 1").fill("Replace compressor contactor");
  await owner.getByLabel("Unit price, option 1 line 1").fill("289.00");
  await owner.getByRole("button", { name: "Add an option" }).click();
  await owner.getByLabel("Option 2 name").fill("Replace");
  await owner.getByLabel("Description, option 2 line 1").fill("3 ton condenser, installed");
  await owner.getByLabel("Unit price, option 2 line 1").fill("5480.00");
  await owner.getByLabel("Recommend option 2").check();
  await owner.getByRole("button", { name: "Save estimate" }).click();
  await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
  const estimateUrl = owner.url();
  await expect(owner.getByRole("region", { name: "Replace" })).toContainText("$5,480.00");

  // A deposit is asked for, then the approval link handed over.
  await owner.getByText("Ask for a deposit").click();
  await owner.getByLabel("Deposit amount").fill("500.00");
  await owner.getByRole("button", { name: "Ask for deposit" }).click();
  await expect(owner.getByText("asked for")).toBeVisible();
  await owner.getByRole("button", { name: "Get the approval link" }).click();
  const link = owner.getByRole("link", { name: /\/e\// });
  await expect(link).toBeVisible();
  const approvalUrl = (await link.getAttribute("href"))!;

  // The link the customer is given points at this deployment.
  expect(new URL(approvalUrl).origin).toBe(new URL(baseURL!).origin);

  await stranger.goto(approvalUrl);
  await expect(stranger.getByText(`Replace the condenser ${run}`).first()).toBeVisible();
  await stranger.getByRole("button", { name: /^Replace/ }).click();
  await stranger.getByPlaceholder("Type your full name to sign").fill("Rosalind Achebe");
  await stranger.getByRole("button", { name: "Approve Replace" }).click();

  // A deposit is due, so approving lands on the page that takes it.
  await expect(stranger).toHaveURL(/\/pay\/[A-Za-z0-9_-]+$/);
  await expect(stranger.getByRole("heading", { name: "Deposit" })).toBeVisible();
  await expect(stranger.getByText("$500.00").first()).toBeVisible();

  // The office sees it approved, signed by the person who typed their name.
  await owner.goto(estimateUrl);
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Approved")).toBeVisible();
  await expect(owner.locator('dt:text-is("Signed by") + dd')).toHaveText("Rosalind Achebe");
  await expect(owner.locator('dt:text-is("Chosen") + dd')).toHaveText("Replace");

  // And the link is spent: opening it again does not offer a second approval.
  await stranger.goto(approvalUrl);
  await expect(stranger.getByRole("button", { name: "Approve Replace" })).toHaveCount(0);

  // Approved work becomes a job, and the deposit follows it.
  await owner.getByRole("button", { name: "Convert to job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(`Replace the condenser ${run}`);
});

test("a customer opens their invoice, their account and the seeded proposal and tracking links without signing in", async ({ owner, stranger, seed, baseURL }) => {
  // The customer and an invoice, through the office screens.
  const name = `Tobias Lindqvist ${run}`;
  await owner.goto("/customers/new");
  await owner.getByLabel("Name").fill(name);
  await owner.getByRole("button", { name: "Save customer" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  const customerUrl = owner.url();

  await owner.getByRole("link", { name: "New invoice" }).click();
  await owner.getByLabel("Line 1 description").fill("Annual furnace tune up");
  await owner.getByLabel("Line 1 unit price").fill("149.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceNumber = (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, "");

  // The two links, handed over from the office.
  await owner.getByRole("button", { name: "Get a link instead" }).click();
  const invoiceLink = owner.getByRole("link", { name: /\/i\// });
  await expect(invoiceLink).toBeVisible();
  const forInvoice = (await invoiceLink.getAttribute("href"))!;

  await owner.goto(customerUrl);
  await owner.getByRole("button", { name: "Get their account link" }).click();
  const accountLink = owner.getByRole("link", { name: /\/c\// });
  await expect(accountLink).toBeVisible();
  const forAccount = (await accountLink.getAttribute("href"))!;

  for (const url of [forInvoice, forAccount]) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
  }

  const invoicePage = await stranger.goto(forInvoice);
  expect(invoicePage?.status()).toBe(200);
  expect(new URL(stranger.url()).pathname).toMatch(/^\/i\//);
  await expect(stranger.getByRole("heading", { name: `Invoice #${invoiceNumber}` })).toBeVisible();
  await expect(stranger.getByText("$149.00").first()).toBeVisible();

  const accountPage = await stranger.goto(forAccount);
  expect(accountPage?.status()).toBe(200);
  expect(new URL(stranger.url()).pathname).toMatch(/^\/c\//);
  await expect(stranger.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(stranger.getByText(`#${invoiceNumber}`).first()).toBeVisible();

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
