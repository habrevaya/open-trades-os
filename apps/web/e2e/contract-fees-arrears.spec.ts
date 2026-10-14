import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CONTRACT'S FIXED FEE BILLED IN ARREARS, AND ENDED PART WAY THROUGH A MONTH
 *
 * Set up on the contract's screen to bill at the end of each month for the
 * month just gone, then ended on the tenth of last month. What is owed is
 * the ten days that ran, charged by the day even though the contract does
 * not charge part months by the day, and the invoice line says so.
 */
test("a fixed fee billed in arrears bills the days that ran when it ends", async ({ owner }) => {
  const today = companyToday();
  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
  const lastDay = `${lastMonth.slice(0, 8)}10`;
  const daysLastMonth = new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0)).getUTCDate();

  const clientId = await newCustomer(owner, { name: `Eastline Clinics ${run}`, phone: "+15125550284" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Eastline maintenance ${run}`);
  await owner.getByLabel("Starts").fill(lastMonth);
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

  const fee = owner.getByRole("region", { name: "Billed on a schedule" });
  await fee.getByLabel("Fee each time").fill("1240.00");
  await fee.getByLabel("Billing day of the month (1 to 28)").fill("1");
  await fee.getByLabel("When it bills").selectOption("arrears");
  await fee.getByLabel("What the invoice says").fill("Planned maintenance, all clinics");
  await fee.getByRole("button", { name: "Save the fee" }).click();
  await expect(fee.getByText("Billed after each period ends, for the period just gone.", { exact: false })).toBeVisible();

  await fee.getByLabel("Last day billed for").fill(lastDay);
  await fee.getByRole("button", { name: "End billing" }).click();
  await expect(fee.getByText("One period is owed now.", { exact: false })).toBeVisible();

  await fee.getByRole("button", { name: "Raise what is owed now" }).click();
  const periods = fee.getByRole("table", { name: "Periods billed" });
  const row = periods.getByRole("row").filter({ hasText: `10 of ${daysLastMonth} days` });
  await expect(row).toContainText(`The last day billed for is ${lastDay}`);

  await row.getByRole("link", { name: /Invoice \d+/ }).click();
  await expect(owner.getByRole("heading", { level: 1, name: /Invoice \d+/ })).toBeVisible();
  await expect(owner.getByText(`10 of ${daysLastMonth} days, charged by the day`, { exact: false }).first()).toBeVisible();
});
