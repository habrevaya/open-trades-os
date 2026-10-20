import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A FEE THAT RISES BY A FIXED AMOUNT, APPLIED LATE
 *
 * A contract a year and six weeks old, billed 1,200.00 a month from its
 * start, every month raised. Its agreement says the fee goes up 50.00 a
 * month each year, and nobody applied year 2 on the anniversary, so the two
 * months since were billed at the old fee. Applying it now offers what each
 * of those months is short, and nothing more: one goes on a draft invoice the
 * office asks for, the other is written down as not billed.
 */
function anniversaryBehind(): string {
  const today = companyToday();
  for (let days = 36; days <= 56; days += 1) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
    if (Number(date.slice(8, 10)) <= 28) return date;
  }
  throw new Error("No anniversary five to eight weeks back falls on day 28 or before.");
}

test("a fee rise applied late offers each short period as a draft invoice, never by itself", async ({ owner }) => {
  test.setTimeout(180_000);
  const anniversary = anniversaryBehind();
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;

  const clientId = await newCustomer(owner, { name: `Quay Offices ${run}`, phone: "+15125550481" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Quay upkeep ${run}`);
  await owner.getByLabel("Starts").fill(startsOn);
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

  const fee = owner.getByRole("region", { name: "Billed on a schedule" });
  await fee.getByLabel("Fee each time").fill("1200.00");
  await fee.getByLabel("Billing day of the month (1 to 28)").fill(String(Number(anniversary.slice(8, 10))));
  await fee.getByLabel("First day billed for").fill(startsOn);
  await fee.getByLabel("What the invoice says").fill("Planned maintenance, the quay");
  await fee.getByLabel(/The fee rises with the contract/).check();
  await fee.getByRole("button", { name: "Save the fee" }).click();
  await expect(fee).toContainText("The fee rises with the contract's yearly rise, when a person applies it.");

  /** A year and more is owed: twelve at a time. */
  await owner.reload();
  await fee.getByRole("button", { name: "Raise what is owed now" }).click();
  await expect(fee.getByRole("status").filter({ hasText: "12 invoices raised." })).toBeVisible();
  await owner.reload();
  await fee.getByRole("button", { name: "Raise what is owed now" }).click();
  /** Nothing is owed once the rest is raised, so the button goes. */
  await expect(fee.getByRole("button", { name: "Raise what is owed now" })).toHaveCount(0);

  const rise = owner.getByRole("region", { name: "Annual escalation" });
  await rise.getByText("Rises that differ by year, card or trade").click();
  await rise.locator('select[name="riseTrade0"]').selectOption({ label: "The fixed fee" });
  await rise.getByLabel("Or an amount, $").nth(0).fill("50");
  await rise.getByRole("button", { name: "Save the rises" }).click();
  await expect(rise.getByText("Saved. The preview above shows what each price rises by.")).toBeVisible();

  await owner.reload();
  const table = rise.getByRole("table", { name: `Fixed fee from ${anniversary}` });
  await expect(table).toContainText("1,250.00");
  await expect(table).toContainText("50.00 more, Every year, the fixed fee");
  await rise.getByRole("button", { name: "Apply year 2 prices" }).click();
  await expect(rise).toContainText(`Last risen on ${anniversary}.`);

  await owner.reload();
  const late = owner.getByRole("region", { name: "Billed before the rise" });
  const rows = late.getByRole("table", { name: "Short by the rise" }).getByRole("row").filter({ hasText: "Not billed yet" });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("$50.00");

  /** Only the first month goes on the draft. */
  await late.getByRole("checkbox").nth(1).uncheck();
  await late.getByRole("button", { name: "Make a draft invoice for the ticked periods" }).click();
  await expect(late.getByRole("status")).toContainText("It is not sent until somebody issues it.");
  await owner.reload();
  await expect(late.getByRole("link", { name: /On draft invoice \d+/ })).toHaveCount(1);

  await late.getByText("Do not bill the difference").click();
  await late.getByRole("button", { name: /^Do not bill / }).click();
  await expect(late.getByText("Not billed, by choice")).toBeVisible();
  await owner.reload();
  await expect(late.getByText("Not billed yet")).toHaveCount(0);

  /** The draft is a draft: nothing was issued for the difference. */
  await late.getByRole("link", { name: /On draft invoice \d+/ }).click();
  await expect(owner.getByRole("region", { name: "Draft" })).toContainText("nothing is owed and nothing is posted until it is issued");
});

test("the rate card editor edits more than six hourly rates at a time", async ({ owner }) => {
  test.setTimeout(120_000);
  const clientId = await newCustomer(owner, { name: `Wharf Offices ${run}`, phone: "+15125550482" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(`Wharf upkeep ${run}`);
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);

  await owner.getByText("Add a rate card").click();
  const cards = owner.getByRole("region", { name: "Rate cards" });
  await cards.getByLabel("Name", { exact: true }).last().fill("Wharf schedule");
  await cards.getByRole("button", { name: "Add the card" }).click();
  const card = owner.getByRole("heading", { name: "Wharf schedule", exact: true }).locator("xpath=../..");
  await expect(card).toBeVisible();

  /** Each row a different trade and time band, because a card refuses two rates for the same pair. */
  const row = async (i: number, band: string, trade: number, rate: string) => {
    await card.locator(`select[name="trade${i}"]`).selectOption({ index: trade });
    await card.locator(`select[name="band${i}"]`).selectOption(band);
    await card.locator(`input[name="rate${i}"]`).fill(rate);
  };
  /** Six rows is what the form shows to start with. */
  await expect(card.locator('input[name="rate5"]')).toHaveCount(1);
  await expect(card.locator('input[name="rate6"]')).toHaveCount(0);
  await row(0, "standard", 0, "90.00");
  await row(1, "after_hours", 0, "120.00");
  await row(2, "weekend", 0, "130.00");
  await row(3, "holiday", 0, "150.00");
  await row(4, "standard", 1, "95.00");
  await row(5, "after_hours", 1, "125.00");
  await card.getByRole("button", { name: "Save the card's rules" }).click();
  /** Once a card has rates its rules fold away, so the page coming back with them folded is the save. */
  await expect(card.locator('input[name="rate0"]')).toBeHidden();

  /** Six saved and two empty rows. A seventh is typed into the first empty one, and every row is kept. */
  await owner.reload();
  await card.getByText("Labour rates, markup and hours").click();
  await expect(card.locator('input[name="rate7"]')).toHaveValue("");
  await row(6, "weekend", 1, "135.00");
  await card.getByRole("button", { name: "Save the card's rules" }).click();
  await expect(card.getByRole("status")).toContainText("Saved.");
  await owner.reload();
  await expect(card.locator('input[name="rate8"]')).toHaveValue("");
  /** Listed by time band, so the order moves; every one of the seven is there. */
  const saved = await card.locator('input[name^="rate"]').evaluateAll((inputs) => inputs
    .filter((i) => /^rate\d+$/.test((i as HTMLInputElement).name)).map((i) => (i as HTMLInputElement).value).filter(Boolean));
  expect(saved.sort()).toEqual(["120.00", "125.00", "130.00", "135.00", "150.00", "90.00", "95.00"]);
});
