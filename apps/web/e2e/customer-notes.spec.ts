import { test, expect, run, newCustomer } from "./fixtures";

/**
 * NOTES ON A CUSTOMER, AND THE ONES THE TECHNICIAN READS AT THE DOOR
 *
 * The office writes two notes on a customer's page: one about money, which
 * stays in the office, and one about the gate, marked for the technician and
 * pinned. The writer fixes a typo while the note is fresh. Ray, on his phone,
 * opens the visit and reads the gate note and nothing about money.
 */

/** Today and the current minute on the company's wall clock, as the booking form takes them. */
function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

test("the office writes notes on a customer and the technician reads only the ones marked for them", async ({ owner, tech }) => {
  const customer = `Nadia Notes ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, phone: "(512) 555-0177",
    address: { street: "77 Gatepost Ln", city: "Austin", state: "TX", zip: "78727" },
  });

  const notes = owner.getByRole("region", { name: "Notes" });
  await expect(notes).toContainText("No notes yet.");
  await notes.getByLabel("New note").fill(`Asked about financing ${run}`);
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(notes.getByRole("listitem").filter({ hasText: `Asked about financing ${run}` })).toBeVisible();

  await notes.getByLabel("New note").fill(`Side gate stickss ${run}`);
  await notes.getByLabel("Show it to the technician on their visits").first().check();
  await notes.getByLabel("Keep it at the top").first().check();
  await notes.getByRole("button", { name: "Add note" }).click();
  const gate = notes.getByRole("listitem").filter({ hasText: `Side gate stickss ${run}` });
  await expect(gate).toContainText("Pinned");
  await expect(gate).toContainText("Technician sees this");
  // Pinned, so it is first, above the newer-or-older rest.
  await expect(notes.getByRole("listitem").first()).toContainText(`Side gate stickss ${run}`);

  // Its writer fixes the typo while it is fresh.
  await gate.getByText(/Fix this note/).click();
  await gate.getByLabel("Note").fill(`Side gate sticks, lift it as you push ${run}`);
  await gate.getByRole("button", { name: "Save the fix" }).click();
  const fixed = notes.getByRole("listitem").filter({ hasText: `Side gate sticks, lift it as you push ${run}` });
  await expect(fixed).toContainText("Fixed by its writer");

  // Booked for this minute on the company's clock with Ray on it.
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("link", { name: "77 Gatepost Ln, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Gate side condenser ${run}`);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

  await tech.goto("/my-day");
  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();
  const fromOffice = visit.getByRole("region", { name: "Notes from the office" });
  await expect(fromOffice).toContainText(`Side gate sticks, lift it as you push ${run}`);
  await expect(fromOffice).toContainText("Pinned");
  await expect(visit).not.toContainText(`Asked about financing ${run}`);
});
