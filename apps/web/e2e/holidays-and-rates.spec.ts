import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A HOLIDAY ON THE LIST, AND THE AFTER HOURS RATE OFFERED, NOT ADDED
 *
 * The office closes the first day the booking page offers, on Settings, and
 * the booking page stops offering it. Then it chooses its after hours rate,
 * books a job for seven in the evening, and the new invoice for that job
 * offers the rate with the reason; it goes on only when somebody presses for
 * it. Booking the job is the one step with no screen of its own here, so it
 * is the API, as the signed in office.
 */

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** `days` from the company's today, as a date input takes it. */
function companyDay(days: number): string {
  const [y, m, d] = companyToday().split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

test("a closed holiday takes a day off the booking page", async ({ owner, stranger }) => {
  await stranger.goto("/book/ridgeline");
  await stranger.getByRole("button", { name: /Seasonal tune up/ }).click();
  const first = stranger.locator("p.uppercase").first();
  await expect(first).toBeVisible();
  const label = (await first.textContent())!.trim();
  const date = Array.from({ length: 60 }, (_, i) => companyDay(i)).find((d) => dayLabel(d) === label);
  expect(date, `a date reads "${label}"`).toBeTruthy();

  await owner.goto("/settings/holidays");
  await owner.getByLabel("Name").fill(`Shop moving day ${run}`);
  await owner.getByLabel("Date").fill(date!);
  await owner.getByLabel("That day").selectOption("closed");
  await owner.getByRole("button", { name: "Add holiday" }).click();
  const row = owner.getByRole("row").filter({ hasText: `Shop moving day ${run}` });
  await expect(row).toContainText("Closed");

  await stranger.reload();
  await stranger.getByRole("button", { name: /Seasonal tune up/ }).click();
  await expect(stranger.locator("p.uppercase").first()).toBeVisible();
  await expect(stranger.locator("p.uppercase").filter({ hasText: label })).toHaveCount(0);

  // Off the list again, and the day comes back.
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("row").filter({ hasText: `Shop moving day ${run}` })).toHaveCount(0);
});

test("a job booked for the evening offers the after hours rate on its invoice, and adds it only when asked", async ({ owner }) => {
  const item = `After hours call-out ${run}`;
  const created = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "fee", code: `AH-${run}`.toUpperCase(), name: item, price: "150.00", taxable: false },
  });
  expect(created.ok()).toBe(true);

  await owner.goto("/settings/holidays");
  await owner.getByLabel("After hours rate").selectOption({ label: `${item} ($150.00)` });
  await owner.getByRole("button", { name: "Save rates" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(owner.getByRole("region", { name: "After hours and holiday rates" })).toContainText(`${item}, $150.00`);

  const customerId = await newCustomer(owner, {
    name: `Evan Evening ${run}`, phone: "5125550177",
    address: { street: "7 Late Ln", city: "Austin", state: "TX", zip: "78702" },
  });
  const properties = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = (await properties.json() as { data: { id: string }[] }).data[0]!.id;
  // A Tuesday at seven in the evening in Austin: after the seeded six o'clock close.
  const day = Array.from({ length: 7 }, (_, i) => companyDay(7 + i))
    .find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 2)!;
  const start = [5, 6].map((offset) => new Date(`${day}T19:00:00-0${offset}:00`)).find((instant) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(instant) === "19")!;
  const job = await owner.request.post("/api/v1/jobs", {
    data: {
      customerId, propertyId, summary: `No heat ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3600_000).toISOString() },
    },
  });
  expect(job.ok()).toBe(true);
  const jobId = (await job.json() as { id: string }).id;

  await owner.goto(`/invoices/new?job=${jobId}`);
  const offer = owner.getByRole("region", { name: "After hours rate" });
  await expect(offer).toContainText("Booked outside your hours");
  await expect(offer).toContainText("after the 18:00 close");
  await expect(offer).toContainText("It is not on this invoice unless you add it.");
  // Not on the invoice yet: the only line is the empty one the form starts with.
  await expect(owner.getByLabel("Line 1 price book item")).toHaveValue("");

  await offer.getByRole("button", { name: `Add ${item}` }).click();
  await expect(offer).toHaveCount(0);
  await expect(owner.getByLabel("Line 2 price book item")).toHaveValue(/[0-9a-f-]{36}/);
  await owner.getByLabel("Line 1 description").fill("Diagnosed a failed igniter");
  await owner.getByLabel("Line 1 unit price").fill("90.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.getByText(item).first()).toBeVisible();
  await expect(owner.locator('dt:text-is("Total") + dd').first()).toHaveText("$240.00");
});
