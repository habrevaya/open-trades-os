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

/** A one pixel PNG, as the camera control would hand over a picture. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("a technician photographs the work and takes cash on /my-day, and the office sees the payment", async ({ owner, tech }) => {
  const customer = `Ines Abara ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, phone: "(512) 555-0161",
    address: { street: "77 Pecan Hollow", city: "Austin", state: "TX", zip: "78745" },
  });

  await owner.getByRole("link", { name: "77 Pecan Hollow, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Water heater pilot out ${run}`);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

  await tech.goto("/my-day");
  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();

  // The camera: a file input that asks the phone for its rear camera.
  const camera = visit.getByLabel("Take a photo");
  await expect(camera).toHaveAttribute("type", "file");
  await expect(camera).toHaveAttribute("accept", "image/*");
  await expect(camera).toHaveAttribute("capture", "environment");
  await camera.setInputFiles({ name: "pilot.png", mimeType: "image/png", buffer: PIXEL });
  // Kept on the phone, its record synced, then its bytes sent when the server asks for them.
  await expect(visit.getByText(/Taken here: 1 sent\./)).toBeVisible({ timeout: 30_000 });

  // Cash, through the same queue as every other tap.
  await expect(visit.getByText("Nothing invoiced for this job yet.", { exact: false })).toBeVisible();
  await visit.getByText("Cash", { exact: true }).click();
  await visit.getByLabel("Amount").fill("85");
  await visit.getByRole("button", { name: "Record cash payment" }).click();
  await expect(visit.getByText("Cash $85.00, sent")).toBeVisible({ timeout: 30_000 });

  // A check needs its number before it goes anywhere.
  await visit.getByText("Check", { exact: true }).click();
  await visit.getByLabel("Amount").fill("20");
  await visit.getByRole("button", { name: "Record check payment" }).click();
  await expect(visit.getByRole("alert").filter({ hasText: "Enter the check number" })).toBeVisible();

  // The office sees the money on the customer, held until it is applied.
  await owner.goto(`/customers/${customerId}`);
  await expect(owner.getByRole("region", { name: "Payments" })).toContainText("$85.00");
});

test("/my-day opens with no signal once it has been opened, and the sign in page forgets it", async ({ owner, tech }) => {
  const customer = `Basement Bo ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, address: { street: `${run.slice(-4)} Cellar Ln`, city: "Austin", state: "TX", zip: "78727" },
  });
  const properties = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = (await properties.json() as { data: { id: string }[] }).data[0]!.id;
  const people = await owner.request.get("/api/v1/technicians");
  const ray = (await people.json() as { technicians: { id: string; displayName: string }[] }).technicians
    .find((t) => t.displayName === "Ray Ortiz")!;
  const start = new Date(Date.now() + 5 * 60_000);
  const booked = await owner.request.post("/api/v1/jobs", {
    data: {
      customerId, propertyId, summary: `Sump pump ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString(), technicianIds: [ray.id] },
    },
  });
  expect(booked.ok(), await booked.text()).toBe(true);

  /** Opened once with a signal: the day is kept on the phone and it says so. */
  await tech.goto("/my-day");
  await expect(tech.getByRole("status").filter({ hasText: "This day is saved on this phone" })).toBeVisible();

  /** No signal at all, and the page still opens, with the day on it. */
  await tech.context().setOffline(true);
  await tech.goto("/my-day");
  await expect(tech.getByRole("article").filter({ hasText: customer })).toBeVisible();
  await expect(tech.getByRole("status").filter({ hasText: "No signal." })).toBeVisible();
  /** Only this page is kept: another screen does not open. */
  await expect(tech.goto("/schedule")).rejects.toThrow();
  await tech.context().setOffline(false);

  /** Signing out lands on the sign in page, which empties what was kept. */
  await tech.goto("/login");
  await expect.poll(() => tech.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("ots-my-day")))).toEqual([]);
});
