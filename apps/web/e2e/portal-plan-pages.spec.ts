import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CUSTOMER ON TWO PLANS SEES EACH PLAN'S PAGE
 *
 * The office gives two plans a page each, with its own heading on what is coming
 * up, and sells both to one customer. Their account link opens the page of the
 * plan they joined first, lists both plans, and opens the other plan's page on
 * a click, with that plan's heading and not the first's. Someone on one plan is
 * offered no choice.
 */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

async function definePlan(owner: Page, name: string): Promise<string> {
  await owner.goto("/agreements/plans");
  const define = owner.getByRole("region", { name: "Define a plan" });
  await define.getByLabel("Name").fill(name);
  await define.getByLabel("Price per term").fill("120.00");
  await define.getByLabel("Term in months").fill("12");
  await ready(owner);
  await define.getByRole("button", { name: "Define plan" }).click();
  await expect(owner).toHaveURL(/\/agreements\/plans\/[0-9a-f-]{36}$/);
  return owner.url().split("/").pop()!;
}

async function sell(owner: Page, customer: string, plan: string): Promise<void> {
  await owner.goto("/agreements/new");
  await owner.getByLabel("Find the customer").fill(customer);
  await ready(owner);
  await owner.getByRole("button", { name: "Find" }).click();
  await owner.getByRole("link", { name: new RegExp(customer) }).click();
  await owner.locator("select[name=\"planId\"]").selectOption({ label: plan });
  await ready(owner);
  await owner.getByRole("button", { name: "Sell agreement" }).click();
  await expect(owner).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);
}

async function giveHeading(owner: Page, planId: string, heading: string): Promise<void> {
  await owner.goto(`/settings/portal/layout?plan=${planId}`);
  await owner.getByLabel("Heading for Coming up").fill(heading);
  await ready(owner);
  await owner.getByRole("button", { name: "Save layout" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Members of this plan see it this way" })).toBeVisible();
}

async function accountLinkFor(owner: Page, customerId: string): Promise<string> {
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("button", { name: "Get their account link" }).click();
  const link = owner.getByRole("link", { name: /\/c\// });
  await expect(link).toBeVisible();
  return (await link.getAttribute("href"))!;
}

test("a customer on two plans chooses between their pages, and one plan gives no choice", async ({ owner, stranger }) => {
  const first = `Gold Club ${run}`;
  const second = `Silver Club ${run}`;
  const both = `Bo Both ${run}`;
  const single = `Sy Single ${run}`;
  const firstHeading = `Gold visit ${run}`;
  const secondHeading = `Silver visit ${run}`;

  const bothId = await newCustomer(owner, { name: both, phone: "5125550188", address: { street: "7 Gold Way", city: "Austin", state: "TX", zip: "78701" } });
  const singleId = await newCustomer(owner, { name: single, phone: "5125550199", address: { street: "8 Silver Way", city: "Austin", state: "TX", zip: "78701" } });

  const firstPlan = await definePlan(owner, first);
  const secondPlan = await definePlan(owner, second);
  await giveHeading(owner, firstPlan, firstHeading);
  await giveHeading(owner, secondPlan, secondHeading);

  /** The first plan is the oldest agreement, so it is the page they land on. */
  await sell(owner, both, first);
  await sell(owner, both, second);
  await sell(owner, single, second);

  const link = await accountLinkFor(owner, bothId);
  await stranger.goto(link);
  await expect(stranger.getByRole("region", { name: firstHeading })).toBeVisible();
  await expect(stranger.getByRole("region", { name: secondHeading })).toHaveCount(0);
  const plans = stranger.getByRole("navigation", { name: "Your plans" });
  await expect(plans).toContainText(first);
  await expect(plans).toContainText(second);
  await expect(plans.locator("[aria-current=page]")).toHaveText(first);

  await plans.getByRole("link", { name: second }).click();
  await expect(stranger).toHaveURL(/\?plan=[0-9a-f-]{36}$/);
  await expect(stranger.getByRole("region", { name: secondHeading })).toBeVisible();
  await expect(stranger.getByRole("region", { name: firstHeading })).toHaveCount(0);
  await expect(plans.locator("[aria-current=page]")).toHaveText(second);

  /** And back again. */
  await plans.getByRole("link", { name: first }).click();
  await expect(stranger.getByRole("region", { name: firstHeading })).toBeVisible();

  /** A plan that is not theirs, asked for by hand, is the page they would have had. */
  await stranger.goto(`${link}?plan=00000000-0000-4000-8000-000000000000`);
  await expect(stranger.getByRole("region", { name: firstHeading })).toBeVisible();

  /** One plan, nothing to choose. */
  await stranger.goto(await accountLinkFor(owner, singleId));
  await expect(stranger.getByRole("region", { name: secondHeading })).toBeVisible();
  await expect(stranger.getByRole("navigation", { name: "Your plans" })).toHaveCount(0);
});
