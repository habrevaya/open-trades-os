import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CONTRACT WHOSE RISES DIFFER: YEAR TWO 3%, AND ONE CARD FIXED
 *
 * Set up on the contract's screen the way an office reads it off the
 * client's agreement: no single yearly rate, a rise for year two, and the
 * emergency card kept as it is. The preview says what each price becomes and
 * why, and nothing changes until a person applies it.
 */
async function addCard(owner: import("@playwright/test").Page, name: string, from: string, line: string) {
  await owner.reload();
  await owner.getByText("Add a rate card").click();
  const form = owner.getByRole("region", { name: "Rate cards" });
  await form.getByLabel("Name", { exact: true }).last().fill(name);
  await form.getByLabel("In force from").fill(from);
  await form.getByRole("button", { name: "Add the card" }).click();
  const card = owner.getByRole("heading", { name, exact: true }).locator("xpath=../..");
  await expect(card).toBeVisible();
  await card.getByText("Load the price list").click();
  await card.getByLabel(/One per line/).fill(line);
  await card.getByRole("button", { name: "Load prices" }).click();
  await expect(card.getByRole("table", { name: `Prices on ${name}` })).toBeVisible();
}

test("a contract's rises can differ by year and by card, and are applied by a person", async ({ owner }) => {
  const today = companyToday();
  const anniversary = new Date(Date.parse(`${today}T12:00:00Z`) + 20 * 864e5).toISOString().slice(0, 10);
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;

  const clientId = await newCustomer(owner, { name: `Bayview Offices ${run}`, phone: "+15125550293" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Bayview upkeep ${run}`);
  await owner.getByLabel("Starts").fill(startsOn);
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

  await addCard(owner, "Bayview schedule", startsOn, "FLT, Filter change, 100.00");
  await addCard(owner, "Emergency schedule", startsOn, "EM, Emergency call out, 200.00");

  const rise = owner.getByRole("region", { name: "Annual escalation" });
  await rise.getByText("Rises that differ by year, card or trade").click();
  await rise.locator('select[name="riseYear0"]').selectOption({ label: "Year 2" });
  await rise.getByLabel("Rise, per cent").nth(0).fill("3");
  await rise.locator('select[name="riseCard1"]').selectOption({ label: "Emergency schedule" });
  await rise.getByLabel("Rise, per cent").nth(1).fill("0");
  await rise.getByRole("button", { name: "Save the rises" }).click();
  await expect(rise.getByText("Saved. The preview above shows what each price rises by.")).toBeVisible();

  await owner.reload();
  const bayview = rise.getByRole("table", { name: `Bayview schedule from ${anniversary}` });
  await expect(bayview.getByRole("row").filter({ hasText: "Filter change" })).toContainText("$103.00");
  await expect(bayview.getByRole("row").filter({ hasText: "Filter change" })).toContainText("3%, Year 2");
  const emergency = rise.getByRole("table", { name: `Emergency schedule from ${anniversary}` });
  await expect(emergency.getByRole("row").filter({ hasText: "Emergency call out" })).toContainText("0%, Every year, Emergency schedule");

  await rise.getByRole("button", { name: "Apply year 2 prices" }).click();
  await expect(rise).toContainText(`Last risen on ${anniversary}.`);
  await owner.reload();
  await expect(owner.getByRole("heading", { name: "Bayview schedule (year 2)" })).toBeVisible();
  await expect(owner.getByRole("table", { name: "Prices on Bayview schedule (year 2)" })).toContainText("$103.00");
  await expect(owner.getByRole("table", { name: "Prices on Emergency schedule (year 2)" })).toContainText("$200.00");
});
