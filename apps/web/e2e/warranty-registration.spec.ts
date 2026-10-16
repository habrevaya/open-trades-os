import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * A MAKER'S REGISTRATION DEADLINE, FROM THE INSTALL TO THE DAY IT IS DONE
 *
 * A part whose maker asks for the unit to be registered within so many days
 * is used on a job as the customer's furnace; the unit's page and the
 * deadlines on /tasks say what to register and by when; saying it was
 * registered closes the deadline.
 */
test("a furnace installed on a job owes its maker a registration, which the unit's page closes", async ({ owner }) => {
  const code = `FUR${run.slice(-6).toUpperCase()}`;
  const part = `Gas furnace ${run}`;
  const serial = `FN-${run}-1`;

  // The term lives on the price book item, empty until somebody says.
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("equipment");
  await owner.getByLabel("Code").fill(code);
  await owner.getByLabel("Name").fill(part);
  await owner.getByLabel("Price").fill("4200.00");
  await expect(owner.getByLabel("Register with the maker within (days)")).toHaveValue("");
  await owner.getByLabel("Register with the maker within (days)").fill("30");
  await ready(owner);
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
  await expect(owner.getByLabel("Register with the maker within (days)").first()).toHaveValue("30");

  await owner.goto("/inventory/serials");
  const tracking = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save" }) });
  await tracking.getByLabel("Part").selectOption({ label: `${part} (${code})` });
  await tracking.getByLabel("Track it").selectOption("serial");
  await tracking.getByRole("button", { name: "Save" }).click();
  await expect(tracking.getByRole("status")).toContainText("Saved.");

  await owner.goto("/inventory");
  const receive = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Receive", exact: true }) });
  await receive.getByLabel("Part").selectOption({ label: `${part} (${code}), by serial` });
  await receive.getByLabel("Into").selectOption({ label: "Shop (warehouse)" });
  await receive.getByLabel("Quantity").fill("1");
  await receive.getByLabel("What it all cost").fill("2100.00");
  await receive.getByLabel("Serial or lot numbers").fill(serial);
  await receive.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(receive.getByRole("status")).toContainText(`Received 1: ${serial}.`);

  const customer = `Imogen Hale ${run}`;
  const street = `${run.slice(-4)} Linden Way`;
  await newCustomer(owner, { name: customer, phone: "512-555-0164", address: { street, city: "Austin", state: "TX", zip: "78745" } });
  await owner.getByRole("link", { name: `${street}, Austin` }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Furnace change ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  await owner.getByLabel("Arrives from").fill("09:00");
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobNumber = (await owner.getByRole("heading", { level: 1 }).locator("span").first().textContent())!.trim();

  await owner.goto("/inventory");
  const use = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Use on the job" }) });
  await use.getByLabel("Part").selectOption({ label: `${part} (${code}), by serial` });
  await use.getByLabel("Taken from").selectOption({ label: "Shop (warehouse)" });
  await use.getByLabel("Job number").fill(jobNumber);
  await use.getByLabel("Serial or lot numbers").fill(serial);
  await use.getByLabel("Record as customer equipment, of the kind").fill("Furnace");
  await use.getByLabel("Make").fill("Carrier");
  await use.getByRole("button", { name: "Use on the job" }).click();
  await expect(use.getByRole("status")).toContainText(`Used 1 on job ${jobNumber}`);

  // The deadline is among the ones the office reads, with the day and the unit.
  const lastDay = new Date(Date.parse(`${companyToday()}T00:00:00Z`) + 30 * 864e5).toISOString().slice(0, 10);
  await owner.goto("/contracts/deadlines");
  const deadline = owner.getByRole("listitem").filter({ hasText: `serial ${serial}` });
  await expect(deadline).toContainText("Register the warranty by");
  await expect(deadline).toContainText(`with Carrier by ${lastDay}`);

  // And on the unit's page, where it is closed by saying it was done.
  await deadline.getByRole("link", { name: "Open the unit" }).click();
  const section = owner.getByRole("region", { name: "Warranty registration" });
  await expect(section).toContainText("The warranty may not start until it is registered.");
  await section.getByLabel("Their reference, if they gave one").fill("CR-4471");
  await ready(owner);
  await section.getByRole("button", { name: "It has been registered" }).click();
  await expect(section.getByRole("status")).toContainText("The deadline to register it is closed.");
  await expect(section).toContainText("Registered with the maker on");
  await expect(section).toContainText("reference CR-4471");
  await expect(section).not.toContainText("The warranty may not start");

  await owner.goto("/contracts/deadlines");
  await expect(owner.getByRole("listitem").filter({ hasText: `serial ${serial}` })).toHaveCount(0);
});
