import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * MEMBERSHIP DEPTH, ON THE SCREENS
 *
 * A plan that leaves part of the price book out of its discount, said where
 * the office reads the agreement; the renewal notice worded and routed on its
 * own screen; and the office booking a stranger by hand into time held for
 * members, refused until somebody says "book anyway".
 */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/** A weekday far enough ahead that a two week hold still holds it, as the company counts days. */
function heldWeekday(): string {
  const day = new Date(Date.now() + 20 * 864e5);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

async function setHold(owner: Page, percent: string, hours: string) {
  await owner.goto("/booking");
  const form = owner.locator("form", { has: owner.locator("input[name=\"reservePercent\"]") });
  await form.locator("input[name=\"reservePercent\"]").fill(percent);
  await form.locator("input[name=\"releaseHours\"]").fill(hours);
  await ready(owner);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}

test("a plan leaves part of the price book out of its discount, and the agreement says what", async ({ owner }) => {
  const plan = `Labour Club ${run}`;
  const name = `Lena Labour ${run}`;
  await newCustomer(owner, { name, phone: "5125550144", address: { street: "8 Labour Ln", city: "Austin", state: "TX", zip: "78701" } });

  await owner.goto("/agreements/plans");
  const define = owner.getByRole("region", { name: "Define a plan" });
  await define.getByLabel("Name").fill(plan);
  await define.getByLabel("Price per term").fill("180.00");
  await define.getByLabel("Term in months").fill("12");
  await define.getByLabel("Discount on work, per cent").fill("15");
  await define.getByLabel("Replacement", { exact: true }).check();
  await ready(owner);
  await define.getByRole("button", { name: "Define plan" }).click();
  await expect(owner).toHaveURL(/\/agreements\/plans\/[0-9a-f-]{36}$/);
  await expect(owner.getByLabel("Replacement", { exact: true })).toBeChecked();

  await owner.goto("/agreements/new");
  await owner.getByLabel("Find the customer").fill(name);
  await ready(owner);
  await owner.getByRole("button", { name: "Find" }).click();
  await owner.getByRole("link", { name: new RegExp(name) }).click();
  await owner.locator("select[name=\"planId\"]").selectOption({ label: plan });
  await ready(owner);
  await owner.getByRole("button", { name: "Sell agreement" }).click();
  await expect(owner).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);
  await expect(owner.getByText(/Members get 15% off eligible work, taken off each line of their estimates and invoices, except Replacement\./)).toBeVisible();
  /** The term it was sold for is listed, still running. */
  await expect(owner.getByRole("region", { name: "Terms" }).getByText("Still running")).toBeVisible();
});

test("the renewal notice is worded and routed on its own screen", async ({ owner }) => {
  await owner.goto("/agreements/renewals");
  await owner.getByRole("link", { name: "Renewal notices" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Renewal notices" })).toBeVisible();

  const words = `Hi {{ customer.firstName }}, {{ plan.name }} renews {{ agreement.renewsOn }}. Reply STOP to opt out. ${run}`;
  await owner.getByLabel("Send them").selectOption("both");
  await owner.locator("textarea[name=\"agreement_renewal.renews.sms:body\"]").fill(words);
  await ready(owner);
  await owner.getByRole("button", { name: "Save notices" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  await owner.reload();
  await expect(owner.getByLabel("Send them")).toHaveValue("both");
  await expect(owner.locator("textarea[name=\"agreement_renewal.renews.sms:body\"]")).toHaveValue(words);

  /** A placeholder the notice does not have is refused in words, not sent as a gap. */
  await owner.locator("textarea[name=\"agreement_renewal.ends.sms:body\"]").fill("Hi {{ customer.nickname }}");
  await ready(owner);
  await owner.getByRole("button", { name: "Save notices" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: /customer\.nickname/ })).toBeVisible();

  await owner.getByLabel("Send them").selectOption("text_first");
  await owner.locator("textarea[name=\"agreement_renewal.ends.sms:body\"]").fill(
    "Hi {{ customer.firstName }}, your {{ plan.name }} with {{ company.name }} covers you until {{ agreement.lastCoveredDay }}. Reply to this message if you would like to renew it.",
  );
  await ready(owner);
  await owner.getByRole("button", { name: "Save notices" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
});

test("the office booking a stranger into time held for members is refused until somebody books anyway", async ({ owner }) => {
  const plan = `Priority Club ${run}`;
  const name = `Sam Stranger ${run}`;
  const day = heldWeekday();

  await owner.goto("/agreements/plans");
  const define = owner.getByRole("region", { name: "Define a plan" });
  await define.getByLabel("Name").fill(plan);
  await define.getByLabel("Price per term").fill("200.00");
  await define.getByLabel("Term in months").fill("12");
  await define.getByLabel(/Seen first/).check();
  await ready(owner);
  await define.getByRole("button", { name: "Define plan" }).click();
  await expect(owner).toHaveURL(/\/agreements\/plans\/[0-9a-f-]{36}$/);
  const planUrl = owner.url();

  const customerId = await newCustomer(owner, {
    name, phone: "5125550155", address: { street: "3 Stranger St", city: "Austin", state: "TX", zip: "78701" },
  });
  await setHold(owner, "90", "336");
  try {
    let refused = false;
    for (let attempt = 0; attempt < 20 && !refused; attempt += 1) {
      await owner.goto(`/jobs/new?customer=${customerId}`);
      await owner.getByLabel("Summary").fill(`No cooling ${run} ${attempt}`);
      await owner.locator("input[name=\"date\"]").fill(day);
      await owner.locator("input[name=\"start\"]").fill("09:00");
      await ready(owner);
      await owner.getByRole("button", { name: "Book job" }).click();
      const alert = owner.getByRole("alert").filter({ hasText: /held for members/ });
      /** Either it was booked and the job opened, or the form said why not. */
      await Promise.race([owner.waitForURL(/\/jobs\/[0-9a-f-]{36}$/), alert.waitFor()]);
      refused = await alert.isVisible();
    }
    expect(refused, "a stranger was refused a place held for members").toBe(true);
    await expect(owner.getByRole("alert").filter({ hasText: /tick Book anyway/ })).toBeVisible();

    await owner.getByLabel(/Book anyway, even into time held for members/).check();
    await ready(owner);
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  } finally {
    await setHold(owner, "0", "48");
    await owner.goto(planUrl);
    await owner.getByLabel(/Seen first/).uncheck();
    await ready(owner);
    await owner.getByRole("button", { name: "Save plan" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  }
});
