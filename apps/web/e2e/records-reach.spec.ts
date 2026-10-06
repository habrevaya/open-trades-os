import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * WHERE A COMPANY'S OWN RECORDS REACH, AND THE NEWER RECURRING SCHEDULES
 *
 * A kind of record the office shows to customers, with one field marked for
 * them and one kept in the office: added on the customer's page, found by
 * the search box, and read on the customer's own account link with only the
 * marked field. And the recurring screen's newer schedules, read back in
 * words, with skipping holidays switched on an existing one.
 */

test("a kind of record shown to the customer carries only the fields marked for them", async ({ owner, browser }) => {
  const key = `warranty_${run}`;
  const name = `Wren Warranty ${run}`;

  await owner.goto("/settings/records");
  const define = owner.getByRole("region", { name: "Define a kind of record" });
  await define.getByLabel("Key it is stored under").fill(key);
  await define.getByLabel("What one is called").fill("Registration");
  await define.getByLabel("More than one").fill("Registrations");
  await define.getByLabel("What each one's name is").fill("Registration number");
  await define.getByLabel("A customer").check();
  await define.getByLabel(/The customer may see these/).check();
  await ready(owner);
  await define.getByRole("button", { name: "Define it" }).click();
  await expect(owner).toHaveURL(new RegExp(`/settings/records/${key}$`));

  const addField = owner.getByRole("region", { name: "Add a field" });
  for (const [label, fieldKey] of [["Brand", "brand"], ["Office notes", "office_notes"]] as const) {
    await addField.getByLabel("Kind of answer").selectOption("text");
    await addField.getByLabel("Label people read").fill(label);
    await addField.getByLabel("Key it is stored under").fill(fieldKey);
    await ready(owner);
    await addField.getByRole("button", { name: "Add the field" }).click();
    await expect(addField.getByRole("status").filter({ hasText: "Added." })).toBeVisible();
  }
  await owner.reload();

  // Nothing is the customer's until marked; mark the brand and keep the notes in the office.
  const sees = owner.getByRole("region", { name: "What the customer sees" });
  await expect(sees).toContainText("Office only");
  await ready(owner);
  await sees.getByRole("button", { name: "Show Brand to the customer" }).click();
  await expect(sees.getByRole("button", { name: "Keep Brand in the office" })).toBeVisible();
  await expect(sees.getByRole("button", { name: "Show Office notes to the customer" })).toBeVisible();

  // One on a customer, from the customer's page.
  const customerId = await newCustomer(owner, { name });
  const panel = owner.getByRole("region", { name: "Registrations" });
  await panel.getByRole("link", { name: "Add a registration" }).click();
  await owner.getByLabel("Registration number").fill(`REG-${run}`);
  await owner.getByLabel("Brand").fill("Carrier");
  await owner.getByLabel("Office notes").fill(`Haggled hard ${run}`);
  await ready(owner);
  await owner.getByRole("button", { name: "Add the registration" }).click();
  await expect(owner.getByRole("region", { name: "Registrations" })).toContainText(`REG-${run}`);

  // The search box finds it by a value, from any screen.
  await owner.goto(`/search?q=${encodeURIComponent(`Haggled hard ${run}`)}`);
  const found = owner.getByRole("region", { name: "Registrations" });
  await found.getByRole("link", { name: `REG-${run}` }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Registration REG-${run}` })).toBeVisible();

  // The customer's own account link: the registration and its brand, never the office's notes.
  const grant = await owner.request.post("/api/v1/portal/grants", {
    data: { customerId, scope: "customer", expiresInDays: 30 },
  });
  expect(grant.ok()).toBe(true);
  const link = (await grant.json() as { url: string }).url;
  const customer = await browser.newPage();
  try {
    await customer.goto(link);
    const block = customer.getByRole("region", { name: "Registrations" });
    await expect(block).toContainText(`REG-${run}`);
    await expect(block).toContainText("Brand");
    await expect(block).toContainText("Carrier");
    await expect(customer.locator("body")).not.toContainText("Office notes");
    await expect(customer.locator("body")).not.toContainText(`Haggled hard ${run}`);
  } finally {
    await customer.close();
  }
});

test("recurring tasks on the first Monday, every few weeks and ticked days, and holidays switched later", async ({ owner }) => {
  await owner.goto("/tasks/recurring");
  const add = async (title: string, how: string, fill: () => Promise<void>) => {
    await owner.getByLabel("What needs doing").fill(title);
    await owner.getByLabel("How often").selectOption(how);
    await fill();
    await ready(owner);
    await owner.getByRole("button", { name: "Add recurring task" }).click();
    return owner.getByRole("row", { name: new RegExp(title) });
  };

  await expect(await add(`Extinguishers ${run}`, "nth_weekday_of_month", async () => {
    await owner.getByLabel(/^Day of the week/).selectOption("1");
    await owner.getByLabel(/^Which one in the month/).selectOption("1");
  })).toContainText("On the first Monday of every month");

  await expect(await add(`Filter round ${run}`, "every_n_weeks", async () => {
    await owner.getByLabel(/^Day of the week/).selectOption("3");
    await owner.getByLabel(/^How many weeks apart/).fill("3");
  })).toContainText("Every 3 weeks on Wednesday");

  const yard = await add(`Yard sweep ${run}`, "chosen_weekdays", async () => {
    await owner.getByRole("checkbox", { name: "Monday" }).check();
    await owner.getByRole("checkbox", { name: "Saturday" }).check();
  });
  await expect(yard).toContainText("Every Monday and Saturday");

  // Not on a holiday, switched on the existing one, and off again.
  await ready(owner);
  await yard.getByRole("button", { name: "Skip holidays" }).click();
  await expect(yard).toContainText("Every Monday and Saturday, not on a holiday");
  await ready(owner);
  await yard.getByRole("button", { name: "Raise on holidays too" }).click();
  await expect(yard).not.toContainText("not on a holiday");
});
