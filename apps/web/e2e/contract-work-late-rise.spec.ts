import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CARD RISE APPLIED LATE, ON JOB WORK
 *
 * Dock Offices' contract says its prices rise 3% a year, and its card pays
 * 420.00 for a condenser fan motor. Nobody applied year 2 on the
 * anniversary, ten days ago, and a job billed since charged last year's
 * 420.00. Applying the rise now offers the 12.60 the motor is short on the
 * contract's page, with the diagnostic named as left out because our price
 * book priced it. Nothing is billed until the office asks for a draft.
 */
test("a card rise applied late offers what job work billed at last year's price is short, as a draft", async ({ owner }) => {
  test.setTimeout(180_000);
  const today = companyToday();
  const anniversary = new Date(Date.parse(`${today}T12:00:00Z`) - 10 * 864e5).toISOString().slice(0, 10);
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;

  const clientId = await newCustomer(owner, {
    name: `Dock Offices ${run}`, phone: "+15125550483",
    address: { street: "8 Dock Rd", city: "Austin", state: "TX", zip: "78702" },
  });
  const propertyHref = (await owner.getByRole("link", { name: "8 Dock Rd, Austin" }).getAttribute("href"))!;

  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Dock upkeep ${run}`);
  await owner.getByLabel("Starts").fill(startsOn);
  await owner.getByLabel("Rates rise each year by, per cent").fill("3");
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
  const contractUrl = owner.url();

  await owner.getByText("Add a rate card").click();
  await owner.getByLabel("Name", { exact: true }).last().fill("Dock schedule");
  await owner.getByLabel("In force from").fill(startsOn);
  await owner.getByRole("button", { name: "Add the card" }).click();
  await expect(owner.getByRole("heading", { name: "Dock schedule" })).toBeVisible();
  await owner.getByText("Load the price list").click();
  await owner.getByLabel(/One per line/).fill("MOT-COND, Condenser fan motor, supplied and fitted, 420.00");
  await owner.getByRole("button", { name: "Load prices" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "1 price loaded." })).toBeVisible();

  // The job, done and billed before anybody applied year 2: last year's 420.00.
  await owner.goto(propertyHref);
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Condenser fan seized ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(today);
  await owner.getByLabel("Arrives from").fill("10:00");
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await owner.getByText("Complete visit 1").first().click();
  await owner.getByLabel("What was done on visit 1").fill("Fan motor seized. Replaced.");
  await owner.getByLabel("Used, line 1").selectOption({ label: "Condenser fan motor ($749.00)" });
  await owner.getByLabel("Used, line 2").selectOption({ label: "Diagnostic fee ($129.00)" });
  await owner.getByRole("button", { name: "Complete visit 1" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Completed")).toBeVisible();
  const billing = owner.getByRole("region", { name: "Billing" });
  await expect(billing.getByRole("row").filter({ hasText: "Condenser fan motor" })).toContainText("$420.00");
  await billing.getByRole("button", { name: "Bill this job" }).click();
  await expect(owner.getByRole("region", { name: "Invoices" }).getByRole("listitem")).toHaveCount(1);

  // Year 2 applied ten days late.
  await owner.goto(contractUrl);
  const rise = owner.getByRole("region", { name: "Annual escalation" });
  await rise.getByRole("button", { name: "Apply year 2 prices" }).click();
  await expect(rise).toContainText(`Last risen on ${anniversary}.`);

  await owner.reload();
  const late = owner.getByRole("region", { name: `Job work billed before the rise from ${anniversary}` });
  const rows = late.getByRole("table", { name: `Short by the rise from ${anniversary}` }).getByRole("row").filter({ hasText: "Not billed yet" });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Condenser fan motor");
  await expect(rows.first()).toContainText("$432.60");
  await expect(rows.first()).toContainText("$12.60");
  await expect(late.getByRole("list", { name: "Left out" })).toContainText("Diagnostic fee: Priced from our price book, not the card.");

  await late.getByRole("button", { name: "Make a draft invoice for the ticked work" }).click();
  /** The only line was billed, so the form goes with it, and the row says which draft it is on. */
  await expect(late.getByRole("link", { name: /On draft invoice \d+/ })).toBeVisible();
  await expect(late.getByRole("button", { name: "Make a draft invoice for the ticked work" })).toHaveCount(0);
  await late.getByRole("link", { name: /On draft invoice \d+/ }).click();
  await expect(owner.getByRole("region", { name: "Draft" })).toContainText("nothing is owed and nothing is posted until it is issued");
  await expect(owner.getByText(`Condenser fan motor, card price rise from ${anniversary}`)).toBeVisible();
});
