import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A PAGE OF THEIR OWN FOR THE MEMBERS OF A PLAN
 *
 * The office defines a plan, sells it to one customer, and in the layout
 * editor gives that plan's members a heading of their own on what is coming
 * up. The member's account link shows it; a customer who is not a member
 * still sees the company's page. Taking the plan's page away puts the member
 * back on the company's.
 */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

async function accountLinkFor(owner: Page, customerId: string): Promise<string> {
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("button", { name: "Get their account link" }).click();
  const link = owner.getByRole("link", { name: /\/c\// });
  await expect(link).toBeVisible();
  return (await link.getAttribute("href"))!;
}

test("the members of a plan see a page of their own, and everyone else the company's", async ({ owner, stranger }) => {
  const plan = `Gold Club ${run}`;
  const member = `Mara Member ${run}`;
  const outsider = `Otto Outsider ${run}`;
  const heading = `Your member visit ${run}`;

  const memberId = await newCustomer(owner, { name: member, phone: "5125550166", address: { street: "5 Gold Way", city: "Austin", state: "TX", zip: "78701" } });
  const outsiderId = await newCustomer(owner, { name: outsider, phone: "5125550177", address: { street: "6 Plain Way", city: "Austin", state: "TX", zip: "78701" } });

  await owner.goto("/agreements/plans");
  const define = owner.getByRole("region", { name: "Define a plan" });
  await define.getByLabel("Name").fill(plan);
  await define.getByLabel("Price per term").fill("120.00");
  await define.getByLabel("Term in months").fill("12");
  await ready(owner);
  await define.getByRole("button", { name: "Define plan" }).click();
  await expect(owner).toHaveURL(/\/agreements\/plans\/[0-9a-f-]{36}$/);
  const planId = owner.url().split("/").pop()!;

  await owner.goto("/agreements/new");
  await owner.getByLabel("Find the customer").fill(member);
  await ready(owner);
  await owner.getByRole("button", { name: "Find" }).click();
  await owner.getByRole("link", { name: new RegExp(member) }).click();
  await owner.locator("select[name=\"planId\"]").selectOption({ label: plan });
  await ready(owner);
  await owner.getByRole("button", { name: "Sell agreement" }).click();
  await expect(owner).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);

  const forMember = await accountLinkFor(owner, memberId);
  const forOutsider = await accountLinkFor(owner, outsiderId);

  // The plan starts on the company's page.
  await owner.goto("/settings/portal/layout");
  await expect(owner.getByRole("navigation", { name: "Whose page" })).toContainText(`${plan} members`);
  await owner.getByRole("link", { name: `${plan} members` }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `What ${plan} members see on their account` })).toBeVisible();
  await expect(owner.getByText("Members of this plan see the company's page")).toBeVisible();

  await owner.getByLabel("Heading for Coming up").fill(heading);
  await ready(owner);
  await owner.getByRole("button", { name: "Save layout" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Members of this plan see it this way" })).toBeVisible();
  await owner.goto(`/settings/portal/layout?plan=${planId}`);
  await expect(owner.getByLabel("Heading for Coming up")).toHaveValue(heading);
  await expect(owner.getByText("Members of this plan see this page. Everyone else sees the company's page.")).toBeVisible();

  // The member's page is the plan's; the outsider's is the company's.
  await stranger.goto(forMember);
  await expect(stranger.getByRole("region", { name: heading })).toBeVisible();
  await stranger.goto(forOutsider);
  await expect(stranger.getByRole("region", { name: heading })).toHaveCount(0);

  // The company's own page is untouched.
  await owner.goto("/settings/portal/layout");
  await expect(owner.getByLabel("Heading for Coming up")).not.toHaveValue(heading);

  // Taking the plan's page away puts the member back on the company's.
  await owner.goto(`/settings/portal/layout?plan=${planId}`);
  await ready(owner);
  await owner.getByRole("button", { name: "Use the company's page for this plan" }).click();
  // The button goes with the page it took away, and the plan is on the company's again.
  await expect(owner.getByText("Members of this plan see the company's page, the same as everyone.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Use the company's page for this plan" })).toHaveCount(0);
  await stranger.goto(forMember);
  await expect(stranger.getByRole("region", { name: heading })).toHaveCount(0);
});
