import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * CANCELLING AN AGREEMENT, WITH A REASON FROM THE LIST
 *
 * The reason is chosen rather than typed, so the retention figures can tell a
 * house sale from a lost customer. "Something else" needs words, and a move
 * or a sale offers to end the customer's link to the address, ticked, which
 * is what keeps a later lapse there out of the churn.
 */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

test("an agreement is cancelled with a coded reason, and a sale ends the link to the address", async ({ owner }) => {
  const plan = `Bin Club ${run}`;
  const name = `Sam Seller ${run}`;
  await newCustomer(owner, { name, phone: "5125550277", address: { street: "12 Sold Ln", city: "Austin", state: "TX", zip: "78702" } });

  await owner.goto("/agreements/plans");
  const define = owner.getByRole("region", { name: "Define a plan" });
  await define.getByLabel("Name").fill(plan);
  await define.getByLabel("Price per term").fill("120.00");
  await define.getByLabel("Term in months").fill("12");
  await ready(owner);
  await define.getByRole("button", { name: "Define plan" }).click();
  await expect(owner).toHaveURL(/\/agreements\/plans\/[0-9a-f-]{36}$/);

  await owner.goto("/agreements/new");
  await owner.getByLabel("Find the customer").fill(name);
  await ready(owner);
  await owner.getByRole("button", { name: "Find" }).click();
  await owner.getByRole("link", { name: new RegExp(name) }).click();
  await owner.locator("select[name=\"planId\"]").selectOption({ label: plan });
  await owner.getByLabel("Covers").selectOption({ label: "12 Sold Ln, Austin" });
  await ready(owner);
  await owner.getByRole("button", { name: "Sell agreement" }).click();
  await expect(owner).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);
  await ready(owner);

  // A reason that is not a move offers nothing about the address.
  const why = owner.getByLabel("Why");
  await why.selectOption({ label: "Price" });
  await expect(owner.getByLabel("They have left the address: end their link to it today")).toHaveCount(0);

  // "Something else" with no words is refused, in words.
  await why.selectOption({ label: "Something else" });
  await expect(owner.getByLabel("In their words")).toBeVisible();

  // A sale: the link to the address is offered, ticked.
  await why.selectOption({ label: "Sold the property" });
  const link = owner.getByLabel("They have left the address: end their link to it today");
  await expect(link).toBeChecked();
  await owner.getByLabel("Anything to add").fill("Closing on the 30th");
  await owner.getByRole("button", { name: "Cancel this agreement" }).click();
  await expect(owner.getByText(/Cancelled on .*: Sold the property\. Closing on the 30th/)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Cancel this agreement" })).toHaveCount(0);
});
