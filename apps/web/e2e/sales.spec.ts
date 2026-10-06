import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * The page has hydrated: `HeldSubmits` sets this once React owns the page.
 * Waited for before a press that submits, so the press lands on the form
 * React is managing rather than on server HTML it may be about to replace.
 */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * SELLING: A PLAN DEFINED AND SOLD, AND AN ESTIMATE SENT AND APPROVED
 *
 * Both used to need the API for a step a contractor does every week. A plan
 * was `POST /v1/agreement-plans` and nothing else, so nobody could sell a
 * membership from the office; an estimate's send offered email and text and
 * delivered neither. Each is driven here the way the office and the customer
 * meet it, on the screens only.
 */

test("a plan is defined on its screen, sold to a customer, and an edit to it leaves the member's price alone", async ({ owner }) => {
  const plan = `Home Care Club ${run}`;
  const name = `Priya Member ${run}`;
  await newCustomer(owner, {
    name, phone: "5125550133",
    address: { street: "4 Plan Way", city: "Austin", state: "TX", zip: "78701" },
  });

  // Defined, with a discount typed as a percentage and the priority perk.
  await owner.goto("/agreements/plans");
  const define = owner.getByRole("region", { name: "Define a plan" });
  await define.getByLabel("Name").fill(plan);
  await define.getByLabel("Price per term").fill("240.00");
  await define.getByLabel("Billed").selectOption("annual");
  await define.getByLabel("Term in months").fill("12");
  await define.getByLabel("Visits included per term").fill("2");
  await define.getByLabel("Discount on work, per cent").fill("10");
  await define.getByLabel(/Seen first/).check();
  await define.getByLabel(/No diagnostic fee/).check();
  await ready(owner);
  await define.getByRole("button", { name: "Define plan" }).click();
  await expect(owner).toHaveURL(/\/agreements\/plans\/[0-9a-f-]{36}$/);
  const planUrl = owner.url();
  await expect(owner.getByRole("heading", { level: 1, name: plan })).toBeVisible();
  await expect(owner.getByText("0 members are on this plan now.")).toBeVisible();

  // Sold: find the customer, pick the plan, and land on the agreement with everything it owes.
  await owner.goto("/agreements/new");
  await owner.getByLabel("Find the customer").fill(name);
  await ready(owner);
  await owner.getByRole("button", { name: "Find" }).click();
  await owner.getByRole("link", { name: new RegExp(name) }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Sell ${name} a plan` })).toBeVisible();
  await owner.locator("select[name=\"planId\"]").selectOption({ label: plan });
  await ready(owner);
  await owner.getByRole("button", { name: "Sell agreement" }).click();
  await expect(owner).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("Members get 10% off eligible work")).toBeVisible();
  await expect(owner.getByText("Perks: seen first on the board, no diagnostic fee.")).toBeVisible();
  await expect(owner.getByText("$240.00").first()).toBeVisible();

  // An edit says who it reaches, and the member keeps the price they bought.
  const agreementUrl = owner.url();
  await owner.goto(planUrl);
  await expect(owner.getByText("1 member is on this plan now.")).toBeVisible();
  await owner.getByLabel("Price per term").fill("300.00");
  await owner.getByLabel("Discount on work, per cent").fill("5");
  await ready(owner);
  await owner.getByRole("button", { name: "Save plan" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.goto(agreementUrl);
  await expect(owner.getByText("Members get 10% off eligible work")).toBeVisible();
  await expect(owner.getByText("$240.00").first()).toBeVisible();

  // On the list, on sale, with what members get.
  await owner.goto("/agreements/plans");
  const row = owner.getByRole("row").filter({ hasText: plan });
  await expect(row).toContainText("5% off, seen first, no diagnostic fee");
  await expect(row).toContainText("on sale");
});

test("an estimate is sent from the office, the refusal is recorded, the customer reads the proposal and approves it", async ({ owner, stranger }) => {
  const name = `Theo Quote ${run}`;
  const customerId = await newCustomer(owner, {
    name, email: `theo+${run}@example.test`,
    address: { street: "77 Quote St", city: "Austin", state: "TX", zip: "78702" },
  });

  // Three options, so the proposal names them by price.
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("link", { name: "New estimate" }).click();
  await owner.getByLabel("Title").fill(`No cooling ${run}`);
  await owner.getByLabel("Option 1 name").fill("Repair");
  await owner.getByLabel("Description, option 1 line 1").fill("Replace contactor");
  await owner.getByLabel("Unit price, option 1 line 1").fill("289.00");
  await owner.getByRole("button", { name: "Add an option" }).click();
  await owner.getByLabel("Option 2 name").fill("Condenser");
  await owner.getByLabel("Description, option 2 line 1").fill("3 ton condenser, installed");
  await owner.getByLabel("Unit price, option 2 line 1").fill("5480.00");
  await owner.getByLabel("Recommend option 2").check();
  await owner.getByRole("button", { name: "Add an option" }).click();
  await owner.getByLabel("Option 3 name").fill("System");
  await owner.getByLabel("Description, option 3 line 1").fill("Full system replacement");
  await owner.getByLabel("Unit price, option 3 line 1").fill("11200.00");
  await owner.getByRole("button", { name: "Save estimate" }).click();
  await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
  const estimateUrl = owner.url();

  // The office's proposal: Good, Better and Best by price, ready to print.
  await owner.getByRole("link", { name: "Proposal to print" }).click();
  const proposal = owner.getByRole("article", { name: "Proposal" });
  await expect(proposal.getByLabel("Condenser", { exact: true })).toContainText("Better");
  await expect(proposal.getByLabel("System", { exact: true })).toContainText("Best");
  await expect(proposal.getByLabel("Repair", { exact: true })).toContainText("Good");
  await expect(proposal).toContainText(name);
  await expect(owner.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", /^\/estimates\/[0-9a-f-]{36}\/pdf$/);

  /*
    Emailed. The seeded company has connected no mail provider, so the send is
    refused in words, recorded on the estimate in red, and nothing else
    changes: it is still a draft and no link went anywhere.
  */
  await owner.goto(estimateUrl);
  const send = owner.getByRole("region", { name: "Send" });
  await expect(send.getByLabel("How")).toHaveValue("email");
  await send.getByLabel("A line from you, above the link").fill("As discussed on the roof.");
  await ready(owner);
  await send.getByRole("button", { name: "Send estimate" }).click();
  await expect(send.getByRole("alert").filter({ hasText: "Not sent." })).toContainText("No email provider is connected");
  await owner.reload();
  await expect(owner.getByRole("region", { name: "Sent" })).toContainText(`by email to theo+${run}@example.test: not sent`);
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Draft")).toBeVisible();

  // Handed over as a link instead.
  const again = owner.getByRole("region", { name: "Send" });
  await again.getByLabel("How").selectOption("link");
  await ready(owner);
  await again.getByRole("button", { name: "Send estimate" }).click();
  const link = again.getByRole("link", { name: /\/e\// });
  await expect(link).toBeVisible();
  const approvalUrl = (await link.getAttribute("href"))!;

  // The customer reads the whole proposal, which does not use the link up, then approves.
  await stranger.goto(approvalUrl);
  await stranger.getByRole("link", { name: "See the full proposal to print or save" }).click();
  await expect(stranger.getByRole("article", { name: "Proposal" })).toContainText("Best");
  await stranger.getByRole("link", { name: "Back to choose and approve" }).click();
  await stranger.getByRole("button", { name: /^Condenser/ }).click();
  await stranger.getByPlaceholder("Type your full name to sign").fill("Theo Quote");
  await stranger.getByRole("button", { name: "Approve Condenser" }).click();
  /** "Approving" while it saves, and gone once the approval has landed. */
  await expect(stranger.getByRole("button", { name: /^Approv/ })).toHaveCount(0);

  // The office sees it approved, and the sends it took.
  await owner.goto(estimateUrl);
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Approved")).toBeVisible();
  await expect(owner.locator('dt:text-is("Chosen") + dd')).toHaveText("Condenser");
  await expect(owner.getByRole("region", { name: "Sent" })).toContainText("as a link: link handed over");

  // And the printed proposal now says who signed instead of offering lines to sign.
  await owner.goto(`${estimateUrl}/proposal`);
  await expect(owner.getByRole("article", { name: "Proposal" })).toContainText("Approved by Theo Quote");
});
