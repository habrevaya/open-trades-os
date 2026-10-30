import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * WHY A PLAN LAPSED, AND RELEASING AN ENDED TERM
 *
 * A plan that ran out is lapsed by the worker with no reason. The office can say why from the
 * agreement's own screen, and can count an ended term's unused visits as earned without waiting for
 * the worker. A term that has not ended offers no button.
 */
const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

test("the office says why a plan lapsed and releases its ended term", async ({ owner }) => {
  test.setTimeout(150_000);
  const plan = `Lapse Club ${run}`;
  const name = `Lena Lapsed ${run}`;
  await newCustomer(owner, { name, phone: "5125550288", address: { street: "14 Lapse Ln", city: "Austin", state: "TX", zip: "78702" } });

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
  await owner.getByLabel("Covers").selectOption({ label: "14 Lapse Ln, Austin" });
  await ready(owner);
  await owner.getByRole("button", { name: "Sell agreement" }).click();
  await expect(owner).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);
  await ready(owner);
  const agreementUrl = owner.url();
  const id = agreementUrl.split("/").pop()!;

  // A term that is still running offers no button, and a running plan has no lapse to explain.
  await expect(owner.getByRole("button", { name: "Release this term" })).toHaveCount(0);
  await expect(owner.getByText("Nobody has said why")).toHaveCount(0);

  // The term ends five days ago and nobody renewed it: what the worker would make of it, without waiting.
  const ended = plus(companyToday(), -5);
  const db = createClient();
  try {
    await db.execute(sql`update public.agreement set status = 'lapsed', ends_on = ${ended}, auto_renews = false where id = ${id}`);
    await db.execute(sql`update public.agreement_term set ends_on = ${ended} where agreement_id = ${id}`);
  } finally {
    await db.$close();
  }

  await owner.goto(agreementUrl);
  await ready(owner);
  await expect(owner.getByText("Lapsed. Nobody has said why.")).toBeVisible();
  await expect(owner.getByText("Ended, not counted yet")).toBeVisible();

  // Something else needs words.
  const lapse = owner.getByRole("region", { name: "Why it lapsed" });
  await lapse.getByLabel("Why it lapsed").selectOption({ label: "Something else" });
  await lapse.getByRole("button", { name: "Save the reason" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "in words" })).toBeVisible();

  // The price, with words, and no change to the address.
  await lapse.getByLabel("Why it lapsed").selectOption({ label: "Price" });
  await lapse.getByLabel("In their words (needed for something else)").fill("Found it cheaper");
  await lapse.getByRole("button", { name: "Save the reason" }).click();
  await expect(lapse.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(owner.getByText("Lapsed: Price. Found it cheaper")).toBeVisible();

  // A link is ended only for a move or a sale.
  await lapse.getByLabel("Why it lapsed").selectOption({ label: "Price" });
  await lapse.getByLabel("They left the address: end their link to it today (a move or a sale only)").check();
  await lapse.getByRole("button", { name: "Change the reason" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Only a move or a sale" })).toBeVisible();

  // Releasing the ended term counts what it held.
  await owner.getByRole("button", { name: "Release this term" }).click();
  await expect(owner.getByText(/Counted as earned: 120/)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Release this term" })).toHaveCount(0);
  await expect(owner.getByText(/not taken, counted|Nothing left to count/).first()).toBeVisible();
});
