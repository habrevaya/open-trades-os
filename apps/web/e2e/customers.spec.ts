import { eq } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * KEEPING CUSTOMERS: RENEWALS, MEMBER PRICES, FOLLOW UPS AND CHANGED PLANS
 *
 * Four things a customer notices when they go wrong. A plan that renews
 * without anybody saying so, a member charged the full price, an estimate
 * nobody chased, and a visit they could not move without ringing in. Each is
 * driven here the way a person meets it: on the screens, with the API used
 * only where there is no screen for a step (defining a plan, selling one,
 * booking a job with a time on it).
 */

/** A calendar day, some days from today, as the API takes it. */
const daysFromNow = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("a member is priced as one, their plan is on the ending soon list, and the office renews it", async ({ owner }) => {
  const name = `Mira Member ${run}`;
  const customerId = await newCustomer(owner, {
    name, phone: "5125550190",
    address: { street: "21 Member Way", city: "Austin", state: "TX", zip: "78701" },
  });

  const plan = await owner.request.post("/api/v1/agreement-plans", {
    data: {
      name: `Comfort Club ${run}`, price: "240.00", billingFrequency: "quarterly",
      termMonths: 12, includedVisitsPerTerm: 2, discountRate: "0.15", renewalNoticeDays: 30,
    },
  });
  expect(plan.ok()).toBe(true);
  const planId = (await plan.json() as { id: string }).id;

  // Sold a year ago less ten days, so it ends ten days from now.
  const sold = await owner.request.post("/api/v1/agreements", {
    data: { planId, customerId, startedOn: daysFromNow(-355) },
  });
  expect(sold.ok()).toBe(true);
  const agreementId = (await sold.json() as { id: string }).id;

  // The composer says so before the save, and each line says so after.
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("link", { name: "New estimate" }).click();
  await expect(owner.getByRole("note")).toContainText(`Comfort Club ${run} takes 15% off each eligible line`);
  await owner.getByLabel("Title").fill(`Coil clean ${run}`);
  await owner.getByLabel("Option 1 name").fill("Clean");
  await owner.getByLabel("Description, option 1 line 1").fill("Evaporator coil clean");
  await owner.getByLabel("Unit price, option 1 line 1").fill("300.00");
  await owner.getByRole("button", { name: "Save estimate" }).click();
  await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
  const option = owner.getByRole("region", { name: "Clean" });
  await expect(option).toContainText("$255.00");
  await expect(option).toContainText(`Member discount, Comfort Club ${run}`);

  // Ending soon, and it will renew on its own.
  await owner.goto("/agreements/renewals");
  const row = owner.getByRole("row").filter({ hasText: name });
  // Ten days in UTC terms, which is ten or eleven in Austin depending on the hour.
  await expect(row).toContainText(/In 1[01] days/);
  await expect(row).toContainText("On its own");
  await row.getByRole("link", { name }).click();
  await expect(owner).toHaveURL(new RegExp(`/agreements/${agreementId}$`));

  // Renewed by hand from its own screen, at the same price.
  const renewal = owner.getByRole("region", { name: "Renewal" });
  await expect(renewal).toContainText("Yes, on");
  await renewal.getByRole("button", { name: "Renew for another term" }).click();
  await expect(renewal).toContainText(/Term\s*2, renewed/);
});

test("the estimate follow up is turned on from the recommended list and opens as an ordinary automation", async ({ owner }) => {
  await owner.goto("/automations");
  const card = owner.getByRole("region", { name: "Follow up an estimate that has not been answered" });
  await card.getByLabel("Days to wait after sending").fill("4");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card.getByText("On", { exact: true })).toBeVisible();

  await card.getByRole("link", { name: "Open it" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Follow up an estimate that has not been answered" })).toBeVisible();
  await expect(owner.getByText("When estimate.sent")).toBeVisible();
  // Its steps are on the canvas like any other automation's.
  await expect(owner.getByRole("region", { name: /step 2, Stop unless still true/ })).toBeVisible();
  await expect(owner.getByRole("region", { name: /step 3, Send the estimate link/ })).toBeVisible();
});

test("a customer asks to move a visit from their link, and the office agrees from the queue", async ({ owner, stranger }) => {
  const name = `Vera Visit ${run}`;
  const customerId = await newCustomer(owner, {
    name, phone: "5125550191",
    address: { street: "5 Change Ct", city: "Austin", state: "TX", zip: "78702" },
  });
  const properties = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = (await properties.json() as { data: { id: string }[] }).data[0]!.id;
  /**
   * The kind of work the seeded company takes online, read from the table
   * because no office route lists a bookable service's job type. Whichever it
   * is, a visit of that kind is one the customer can be offered windows for.
   */
  const db = createClient();
  const [offered] = await db.select({ jobTypeId: schema.bookableService.jobTypeId })
    .from(schema.bookableService)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.bookableService.organizationId))
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  await db.$close();
  const tuneUp = { id: offered!.jobTypeId };

  // A visit six days out, of a kind the company takes online bookings for.
  const start = new Date(`${daysFromNow(6)}T15:00:00Z`);
  const created = await owner.request.post("/api/v1/jobs", {
    data: {
      customerId, propertyId, jobTypeId: tuneUp.id, summary: `Tune up ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 4 * 3600_000).toISOString() },
    },
  });
  expect(created.ok()).toBe(true);
  const jobId = (await created.json() as { id: string }).id;

  const grant = await owner.request.post("/api/v1/portal/grants", {
    data: { customerId, scope: "job", subjectId: jobId, expiresInDays: 30 },
  });
  const link = (await grant.json() as { url: string }).url;

  // The customer, holding only the link.
  await stranger.goto(link);
  await stranger.getByRole("link", { name: "Need to change or cancel this visit?" }).click();
  await expect(stranger.getByRole("heading", { name: "Change your visit" })).toBeVisible();
  await stranger.getByRole("button", { name: "Move it to another time" }).click();
  await stranger.getByRole("radio").first().check();
  await stranger.getByLabel("Anything the office should know? (optional)").fill("Away that week");
  await stranger.getByRole("button", { name: "Ask to move it" }).click();
  // Asked, and said so: the page shows the request waiting, and nothing else to press.
  await expect(stranger.getByText(/You have asked to move this visit to/)).toBeVisible();
  await expect(stranger.getByRole("button", { name: "Ask to move it" })).toHaveCount(0);

  // Nothing moved: the office sees a request, on the job and in the queue.
  await owner.goto(`/jobs/${jobId}`);
  await expect(owner.getByRole("region", { name: `${name} asks to move a visit` })).toBeVisible();

  await owner.goto("/tasks");
  const request = owner.getByRole("region", { name: `${name} asks to move a visit` });
  await expect(request).toContainText("In their words: Away that week");
  await request.getByRole("button", { name: "Agree and move it" }).click();
  // Answered, so it leaves the queue: the task closes with the decision.
  await expect(request).toHaveCount(0);
  await owner.goto(`/jobs/${jobId}`);
  await expect(owner.getByRole("region", { name: `${name} asks to move a visit` })).toHaveCount(0);

  // And the customer's page says it was agreed.
  await stranger.reload();
  await expect(stranger.getByText("Your last request about this visit was agreed.")).toBeVisible();
});
