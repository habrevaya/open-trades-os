import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CONTRACT BILLED A FIXED FEE EVERY MONTH
 *
 * Set up on the contract's own screen the way an office would: the fee, how
 * often, the billing day and the first day billed. The worker raises each
 * month on its billing day; the screen's own button raises what is owed now,
 * through the same claim on each period, so pressing it twice bills nothing
 * twice. Then billing is paused, which takes the pause button away and offers
 * to start it again.
 *
 * The numbers: a fee of 950.00 from the first of last month, billed on the
 * first, owes two months by today: last month and this one.
 */
test("a contract's fixed fee is billed each month, once, and can be paused", async ({ owner }) => {
  const today = companyToday();
  const thisMonth = `${today.slice(0, 8)}01`;
  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);

  const clientId = await newCustomer(owner, { name: `Northgate Offices ${run}`, phone: "+15125550281" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Northgate maintenance ${run}`);
  await owner.getByLabel("Starts").fill(lastMonth);
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

  const fee = owner.getByRole("region", { name: "Billed on a schedule" });
  await expect(fee.getByText("Not billed on a schedule.")).toBeVisible();
  await fee.getByLabel("Fee each time").fill("950.00");
  await fee.getByLabel("Billing day of the month (1 to 28)").fill("1");
  await fee.getByLabel("What the invoice says").fill("Planned maintenance, all floors");
  await fee.getByRole("button", { name: "Save the fee" }).click();
  await expect(fee.getByText("2 periods are owed now.", { exact: false })).toBeVisible();
  await expect(fee.getByText(/^Next:/)).toContainText("$950.00");

  await fee.getByRole("button", { name: "Raise what is owed now" }).click();
  await expect(fee.getByRole("button", { name: "Raise what is owed now" })).toHaveCount(0);
  const periods = fee.getByRole("table", { name: "Periods billed" });
  await expect(periods.getByRole("row")).toHaveCount(3);
  await expect(periods.getByRole("row").filter({ hasText: thisMonth }).getByRole("link", { name: /Invoice \d+/ })).toBeVisible();
  await expect(periods.getByRole("row").filter({ hasText: lastMonth }).getByRole("link", { name: /Invoice \d+/ })).toBeVisible();

  // The invoice itself: the contract's customer, the fee, the period in words.
  await periods.getByRole("row").filter({ hasText: thisMonth }).getByRole("link", { name: /Invoice \d+/ }).click();
  await expect(owner.getByRole("heading", { level: 1, name: /Invoice \d+/ })).toBeVisible();
  await expect(owner.getByText("Planned maintenance, all floors").first()).toBeVisible();
  await expect(owner.getByText("The contract's fee for the period.", { exact: false }).first()).toBeVisible();
  await expect(owner.getByText(`Northgate Offices ${run}`).first()).toBeVisible();
  await owner.goBack();

  // Paused: nothing more is billed, and it can be started again.
  await fee.getByRole("button", { name: "Pause billing" }).click();
  await expect(fee.getByText(/Paused since/)).toBeVisible();
  await expect(fee.getByRole("button", { name: "Start billing again" })).toBeVisible();
  await expect(fee.getByRole("button", { name: "Pause billing" })).toHaveCount(0);
});
