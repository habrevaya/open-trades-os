import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A HOME WARRANTY JOB, BILLED IN TWO PARTS
 *
 * The whole commercial path through the screens, the way an office would
 * take it: the warranty company set up as a customer with a contract and a
 * schedule, a homeowner's job done and recorded, the coverage and the
 * deductible said on the job, the warranty company named as who pays, and
 * the job billed. Two invoices come out, priced by two authorities, adding up
 * to the work. The claim is filed on the warranty company's invoice, approved
 * for less and paid, and the warranty company gets a link to its invoices.
 *
 * The numbers: the seeded price book charges 749.00 for a condenser fan
 * motor and 129.00 for a diagnostic. The warranty schedule pays 420.00 for
 * the motor, less the homeowner's 100.00 deductible, so the warranty company
 * owes 320.00 and the homeowner 229.00: the deductible and the diagnostic,
 * which a home warranty does not cover.
 */
test("a home warranty job is billed in two parts, claimed and paid", async ({ owner, stranger }) => {
  const warranty = `Shield Home Warranty ${run}`;
  const warrantyId = await newCustomer(owner, { name: warranty, phone: "+15125550190" });
  await newCustomer(owner, {
    name: `Hana Ito ${run}`, phone: "+15125550191",
    address: { street: "41 Live Oak Ln", city: "Austin", state: "TX", zip: "78704" },
  });
  const address = owner.getByRole("link", { name: "41 Live Oak Ln, Austin" });
  const propertyHref = (await address.getAttribute("href"))!;

  // The warranty company's contract, its schedule, and the motor on it.
  await owner.goto(`/contracts/new?customer=${warrantyId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Shield network agreement ${run}`);
  await owner.getByLabel("Claim within, days of finishing").fill("60");
  await owner.getByLabel("Their invoice file").selectOption("csv");
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
  const contractUrl = owner.url();

  await owner.getByText("Add a rate card").click();
  await owner.getByLabel("Name", { exact: true }).fill("Shield schedule");
  await owner.getByLabel("Whose schedule").selectOption("warranty_network");
  await owner.getByRole("button", { name: "Add the card" }).click();
  await expect(owner.getByRole("heading", { name: "Shield schedule" })).toBeVisible();
  await owner.getByText("Load the price list").click();
  await owner.getByLabel(/One per line/).fill("MOT-COND, Condenser fan motor, supplied and fitted, 420.00");
  await owner.getByRole("button", { name: "Load prices" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "1 price loaded." })).toBeVisible();

  // The homeowner's job, booked and done: the motor and the diagnostic.
  await owner.goto(propertyHref);
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Condenser fan seized ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  await owner.getByLabel("Arrives from").fill("10:00");
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();
  await owner.getByText("Complete visit 1").first().click();
  await owner.getByLabel("What was done on visit 1").fill("Fan motor seized. Replaced under the home warranty.");
  await owner.getByLabel("Used, line 1").selectOption({ label: "Condenser fan motor ($749.00)" });
  await owner.getByLabel("Used, line 2").selectOption({ label: "Diagnostic fee ($129.00)" });
  await owner.getByRole("button", { name: "Complete visit 1" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Completed")).toBeVisible();

  // Who is paying, and why: the home warranty, with the deductible, and the warranty company named.
  await owner.getByLabel("Who is paying").selectOption("home_warranty");
  await owner.getByLabel("Claim or reference").fill("SHW-5521");
  await owner.getByLabel("Deductible or call fee").fill("100.00");
  await owner.locator("form").filter({ has: owner.getByLabel("Who is paying") })
    .getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("They pay a rate card.")).toBeVisible();
  await owner.getByLabel("Pays", { exact: true }).selectOption({ label: warranty });
  await owner.getByRole("button", { name: "Save who is involved" }).click();

  // The plan, priced by two authorities, split two ways, adding up to the work.
  const billing = owner.getByRole("region", { name: "Billing" });
  await expect(billing.getByRole("row").filter({ hasText: "Condenser fan motor" })).toContainText("Warranty network schedule");
  await expect(billing.getByRole("row").filter({ hasText: "Diagnostic fee" })).toContainText("Our price book");
  await expect(billing.getByText("Priced at")).toContainText("$549.00");
  await expect(billing.getByRole("listitem").filter({ hasText: warranty }).first()).toContainText("$320.00");
  await expect(billing.getByRole("listitem").filter({ hasText: `Hana Ito ${run}` }).first()).toContainText("$229.00");
  await billing.getByRole("button", { name: "Bill in 2 parts" }).click();

  // Two invoices on the job, and nothing left to bill.
  const invoices = owner.getByRole("region", { name: "Invoices" });
  await expect(invoices.getByRole("listitem")).toHaveCount(2);
  await expect(owner.getByRole("region", { name: "Billing" })).toHaveCount(0);
  await expect(invoices).toContainText("$320.00");
  await expect(invoices).toContainText("$229.00");

  // The warranty company's invoice: priced by its schedule, and the claim filed on it.
  await invoices.getByRole("listitem").filter({ hasText: "$320.00" }).getByRole("link").click();
  await expect(owner.getByText(/Priced by Warranty network schedule/).first()).toBeVisible();
  await owner.getByLabel("Their claim or authorisation number").fill("SHW-5521");
  await owner.getByRole("button", { name: "File the claim" }).click();
  await expect(owner).toHaveURL(/\/invoices\/claims\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Submitted")).toBeVisible();

  // Approved for less, then paid what they agreed.
  await owner.getByLabel("Approved for (empty for the full claim)").fill("300.00");
  await owner.getByRole("button", { name: "Record their decision" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Approved")).toBeVisible();
  await expect(owner.getByLabel("Amount", { exact: true })).toHaveValue("300.00");
  await owner.getByLabel("Their payment reference").fill("EFT 88112");
  await owner.getByRole("button", { name: "Record their payment" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid")).toBeVisible();
  await expect(owner.getByText(/They will not pay \$20\.00 of this/)).toBeVisible();

  // The claim clock the contract started is met.
  await owner.goto(jobUrl);
  const deadlines = owner.getByRole("region", { name: "Contract and deadlines" });
  await expect(deadlines.getByRole("listitem").filter({ hasText: "Claim by" })).toContainText("Met");

  // A link for the warranty company, listing what it owes.
  await owner.goto(contractUrl);
  await owner.getByRole("button", { name: "Make a link to their invoices" }).click();
  const link = owner.getByRole("link", { name: /\/p\// });
  await expect(link).toBeVisible();
  await stranger.goto((await link.getAttribute("href"))!);
  await expect(stranger.getByRole("heading", { name: `Invoices for ${warranty}` })).toBeVisible();
  await expect(stranger.getByText("Priced by Warranty network schedule").first()).toBeVisible();
  await expect(stranger.getByText("Diagnostic fee")).toHaveCount(0);
});
