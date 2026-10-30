import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A TEAM TURNED AWAY AT THE DOOR CALLS THE VISIT OFF FROM /my-day
 *
 * The office books a visit for today with Ray on it. Ray, at the door, opens
 * "Call off this visit" under the card, is asked who called it off with no
 * default, and chooses the customer turning him away, with what they said.
 * It goes through the queue, the visit leaves his day as cancelled, and the
 * visit's own page in the office says the customer asked, with his words in
 * the notes.
 */

/** Today and the current minute on the company's wall clock, as the booking form takes them. */
function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

test("a technician turned away at the door calls the visit off from /my-day, and the office sees who asked", async ({ owner, tech }) => {
  test.setTimeout(180_000);
  const customer = `Dora Doorstep ${run}`;
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0171",
    address: { street: "33 Porch Lane", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "33 Porch Lane, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Dryer vent clean ${run}`);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();

  await tech.goto("/my-day");
  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();
  await visit.getByText("Call off this visit").click();

  /** Who asked is never assumed. */
  await visit.getByRole("button", { name: "Call it off" }).click();
  await expect(visit.getByRole("alert").filter({ hasText: "Say who called it off" })).toBeVisible();
  /** Something else asks for words, as the office's form does. */
  await visit.getByLabel("We called it off: something else").check();
  await visit.getByRole("button", { name: "Call it off" }).click();
  await expect(visit.getByRole("alert").filter({ hasText: "Say what the reason was" })).toBeVisible();

  await visit.getByLabel("The customer turned us away").check();
  await visit.getByLabel("What they said (optional)").fill("Said the dryer was fixed by a neighbour");
  await visit.getByRole("button", { name: "Call it off" }).click();
  await expect(visit).toContainText(/cancelled/i);
  await expect(tech.getByText(/All sent/)).toBeVisible();
  await tech.reload();
  await expect(tech.getByRole("article").filter({ hasText: customer })).toContainText(/cancelled/i);

  /** The office reads it on the visit's own page, the way it reads one it called off itself. */
  await owner.goto(jobUrl);
  await owner.getByRole("link", { name: "Open visit 1" }).click();
  await expect(owner).toHaveURL(/\/visits\/[0-9a-f-]{36}$/);
  await expect(owner.getByText(/^The customer asked, /)).toBeVisible();
  await expect(owner.getByText("Turned away at the door: Said the dryer was fixed by a neighbour")).toBeVisible();
});
