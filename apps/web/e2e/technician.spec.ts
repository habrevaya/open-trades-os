import { test, expect, run, newCustomer } from "./fixtures";
import { setBrowserDeviceRevoked } from "./devices";

/**
 * A TECHNICIAN'S DAY, ON A PHONE
 *
 * The office takes the call on its screens: the customer and their address,
 * and a job booked for now with Ray ticked to go. Ray, on a phone sized
 * screen, clocks in, tells the customer he is on the way, starts, writes down
 * what he found and finishes. The office then sees it done.
 *
 * Every tap goes through the same offline queue and sync the native app
 * will, so this is the path that has to survive a basement.
 */

/** Today and the current minute on the company's wall clock, as the booking form takes them. */
function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

test("a technician runs a visit from a phone, and the office sees it finished", async ({ owner, tech }) => {
  const customer = `Marguerite Oyelaran ${run}`;
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0149",
    address: { street: "604 Elm Ridge Rd", city: "Austin", state: "TX", zip: "78727" },
  });

  /*
    Booked for this minute on the seeded company's clock (America/Chicago),
    so the visit is on today's page whatever the zone of the machine running
    this, at any hour, including a few minutes after midnight.
  */
  await owner.getByRole("link", { name: "604 Elm Ridge Rd, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Furnace short cycling ${run}`);
  await owner.getByLabel("Customer said").fill("Turns on and off every couple of minutes");
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();
  await expect(owner.getByRole("table").last()).toContainText("Ray Ortiz");

  await tech.goto("/my-day");
  await expect(tech.getByRole("heading", { level: 1 })).toBeVisible();

  // The phone layout: nothing wider than the screen.
  const overflow = await tech.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await tech.getByRole("button", { name: "Clock in" }).click();
  await expect(tech.getByRole("button", { name: "Clock out" })).toBeVisible();

  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();
  await expect(visit.getByText("Turns on and off every couple of minutes")).toBeVisible();

  // The customer is told, through the same consent decision as every text.
  await visit.getByRole("combobox").selectOption("20");
  await visit.getByRole("button", { name: "Text the customer I am on my way" }).click();
  await expect(visit.getByRole("status")).toHaveText("Texted: about 20 minutes away.");

  await visit.getByRole("button", { name: "On my way", exact: true }).click();
  await visit.getByRole("button", { name: "Start work" }).click();

  await visit.getByPlaceholder("What you found").fill("Flame sensor coated. Cleaned it, ran three full cycles.");
  await visit.getByRole("button", { name: "Save note" }).click();

  await visit.getByRole("button", { name: "Finish" }).click();
  await expect(visit).toContainText(/completed/i);

  // Not just on the phone: in the system, once the queue has synced.
  await expect(tech.getByText(/All sent/)).toBeVisible();
  await tech.reload();
  await expect(tech.getByRole("article").filter({ hasText: customer })).toContainText(/completed/i);

  await owner.goto(jobUrl);
  await expect(owner.getByRole("table").last()).toContainText("Completed");
});

test("a punch the server refuses says why beside the clock, straight away, instead of looking as if it worked", async ({ tech }) => {
  await tech.goto("/my-day");
  const clock = tech.getByRole("button", { name: /^Clock (in|out)$/ });
  await expect(clock).toBeVisible();
  const pressed = (await clock.textContent())!.trim();

  // The office revokes this phone while it is open in the technician's hand.
  await setBrowserDeviceRevoked("Ray Ortiz", true);
  try {
    await clock.click();
    const said = pressed === "Clock in" ? "Not clocked in yet" : "Not clocked out yet";
    await expect(tech.getByRole("alert").filter({ hasText: said })).toContainText("This device has been revoked.");
  } finally {
    await setBrowserDeviceRevoked("Ray Ortiz", false);
  }

  // Allowed again, the punch kept on the phone goes through and the notice clears.
  await tech.reload();
  await expect(tech.getByText(/All sent/)).toBeVisible();
  await expect(tech.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(tech.getByRole("button", { name: pressed === "Clock in" ? "Clock out" : "Clock in" })).toBeVisible();
});
