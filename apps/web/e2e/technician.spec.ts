import { test, expect, run, api } from "./fixtures";

/**
 * A TECHNICIAN'S DAY, ON A PHONE
 *
 * The office books a visit starting now and puts Ray on it. Ray, on a
 * phone sized screen, clocks in, tells the customer he is on the way, starts,
 * writes down what he found and finishes. The office then sees it done.
 *
 * Every tap goes through the same offline queue and sync the native app
 * will, so this is the path that has to survive a basement.
 */
test("a technician runs a visit from a phone, and the office sees it finished", async ({ owner, tech }) => {
  const customer = `Marguerite Oyelaran ${run}`;
  const created = await api<{ id: string }>(owner.request, "POST", "/v1/customers", {
    type: "residential", name: customer, phone: "(512) 555-0149",
    property: { address: { line1: "604 Elm Ridge Rd", city: "Austin", state: "TX", postalCode: "78727", country: "US" } },
  });
  const { data: [property] } = await api<{ data: { id: string }[] }>(owner.request, "GET", `/v1/properties?customerId=${created.id}`);
  const { people } = await api<{ people: { name: string | null; displayName: string | null; technicianId: string | null }[] }>(
    owner.request, "GET", "/v1/people");
  const ray = people.find((p) => (p.displayName ?? p.name) === "Ray Ortiz" && p.technicianId)!;

  const now = Date.now();
  const job = await api<{ id: string; visits: { id: string }[] }>(owner.request, "POST", "/v1/jobs", {
    customerId: created.id, propertyId: property!.id,
    summary: `Furnace short cycling ${run}`,
    customerComplaint: "Turns on and off every couple of minutes",
    visit: {
      // Starting now rather than a little earlier, so the visit is on today's
      // page in any timezone, at any hour, including a few minutes after midnight.
      windowStart: new Date(now + 60_000).toISOString(),
      windowEnd: new Date(now + 121 * 60_000).toISOString(),
      estimatedDurationMinutes: 60,
      technicianIds: [ray.technicianId],
    },
  });

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

  await owner.goto(`/jobs/${job.id}`);
  await expect(owner.getByRole("table").last()).toContainText("Completed");
});
