import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * SMALLER GAPS IN THE OFFICE AND IN THE FIELD
 *
 * The after hours rate on an estimate and on the phone's invoice, and the
 * working hours escalation rule. Each is a screen somebody uses, driven the
 * way they use it.
 */

/** Today on the company's wall clock, as the booking form takes it. */
function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/** The company's after hours rate, as a price book item chosen on the holidays page. */
async function chooseRate(owner: Page, name: string, code: string): Promise<void> {
  const created = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "fee", code, name, price: "150.00", taxable: false },
  });
  expect(created.ok()).toBe(true);
  await owner.goto("/settings/holidays");
  await owner.getByLabel("After hours rate").selectOption({ label: `${name} ($150.00)` });
  await owner.getByRole("button", { name: "Save rates" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}

/** A job for Ray at nine in the evening today, which is outside the seeded hours on any day. */
async function bookEvening(owner: Page, customer: string, street: string, summary: string): Promise<string> {
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0188",
    address: { street, city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: `${street}, Austin` }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(summary);
  await owner.getByLabel("Day", { exact: true }).fill(companyNow("America/Chicago").date);
  await owner.getByLabel("Arrives from").fill("21:00");
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  return owner.url().split("/").pop()!;
}

test("an estimate for an evening job offers the after hours rate, and puts it on every option only when asked", async ({ owner }) => {
  const item = `After hours call-out E ${run}`;
  await chooseRate(owner, item, `AHE-${run}`.toUpperCase());
  const jobId = await bookEvening(owner, `Estelle Evening ${run}`, "88 Lamplight Ln", `No heat, evening ${run}`);

  await owner.goto(`/jobs/${jobId}`);
  await owner.getByRole("link", { name: "Write an estimate for this job" }).click();
  await expect(owner).toHaveURL(/\/estimates\/new\?.*job=/);
  const offer = owner.getByRole("region", { name: "After hours rate" });
  await expect(offer).toContainText("Booked outside your hours");
  await expect(offer).toContainText("at 21:00");
  await expect(offer).toContainText("It is not on this estimate unless you add it.");
  // Not on the estimate yet.
  await expect(owner.getByLabel("Price book item, option 1 line 1")).toHaveValue("");

  await owner.getByRole("button", { name: "Add an option" }).click();
  await offer.getByRole("button", { name: `Add ${item} to every option` }).click();
  await expect(offer).toHaveCount(0);
  // On both options, after the empty line each started with.
  await expect(owner.getByLabel("Price book item, option 1 line 2")).toHaveValue(/[0-9a-f-]{36}/);
  await expect(owner.getByLabel("Price book item, option 2 line 2")).toHaveValue(/[0-9a-f-]{36}/);

  for (const option of [1, 2]) {
    const choose = owner.getByLabel(`Price book item, option ${option} line 1`);
    const label = await choose.locator("option", { hasText: "Hot surface igniter" }).first().textContent();
    await choose.selectOption({ label: label! });
  }
  await owner.getByRole("button", { name: "Save estimate" }).click();
  await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
  await expect(owner.getByText(item).first()).toBeVisible();
});

test("on /my-day the after hours rate is offered on the estimate and on the invoice, and added only when asked", async ({ owner, tech }) => {
  const item = `After hours call-out P ${run}`;
  const customer = `Pia Evening ${run}`;
  await chooseRate(owner, item, `AHP-${run}`.toUpperCase());
  const part = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "material", code: `CAP-${run}`.toUpperCase(), name: `Run capacitor ${run}`, price: "40.00", taxable: false },
  });
  const partId = ((await part.json()) as { id: string }).id;
  const jobId = await bookEvening(owner, customer, "9 Moonrise Dr", `No cooling, evening ${run}`);

  // The office records the part used on the visit, so it is work the phone can bill.
  const job = await owner.request.get(`/api/v1/jobs/${jobId}`);
  const visitId = ((await job.json()) as { visits: { id: string }[] }).visits[0]!.id;
  const completed = await owner.request.post(`/api/v1/visits/${visitId}/complete`, {
    headers: { "idempotency-key": `ops-gaps-${run}` },
    data: { partsUsed: [{ priceBookItemId: partId, quantity: "1" }] },
  });
  expect(completed.ok()).toBe(true);

  await tech.goto("/my-day");
  await ready(tech);
  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();

  // The estimate builder offers it, with why, and it goes on only when pressed.
  await visit.getByRole("button", { name: "Build good, better, best" }).click();
  const builder = visit.getByRole("region", { name: "New estimate" });
  await expect(builder).toContainText("Booked outside your hours");
  await expect(builder).toContainText("It is not on this estimate unless you add it.");
  await expect(builder).toContainText("Nothing on it yet");
  await builder.getByRole("button", { name: `Add ${item} to every option` }).click();
  await expect(builder).not.toContainText("It is not on this estimate unless you add it.");
  await expect(builder.getByRole("tab", { name: /Good/ })).toContainText("$150.00");
  await builder.getByRole("button", { name: "Cancel" }).click();

  // The invoice for the recorded work offers it too, and the figure the customer signs follows the button.
  const invoice = visit.getByRole("region", { name: "Invoice" });
  await invoice.getByRole("button", { name: "Raise the invoice" }).click();
  await invoice.getByRole("radio", { name: /The parts and charges recorded/ }).check();
  await expect(invoice).toContainText("Booked outside your hours");
  await expect(invoice).toContainText("It is not on this invoice unless you add it.");
  await invoice.getByRole("button", { name: "Show the customer" }).click();
  const without = await invoice.locator("p", { hasText: /^Total/ }).textContent();
  expect(without).toContain("$40.00");
  await invoice.getByRole("button", { name: "Back" }).click();
  await invoice.getByRole("button", { name: `Add ${item}` }).click();
  await invoice.getByRole("button", { name: "Show the customer" }).click();
  await expect(invoice).toContainText(item);
  await expect(invoice.locator("p", { hasText: /^Total/ })).toContainText("$190.00");
  await invoice.getByRole("button", { name: "The customer is not here: raise it unsigned" }).click();
  await expect(invoice).toContainText("Invoice raised here: $190.00");
  await expect(tech.getByText(/All sent/)).toBeVisible();

  // The office has the invoice issued at that figure, with the rate on it, not kept as a draft.
  await owner.goto(`/jobs/${jobId}`);
  const raised = owner.getByRole("region", { name: "Invoices" }).getByRole("listitem").filter({ hasText: "$190.00" });
  await expect(raised).toHaveCount(1);
  await expect(raised).not.toContainText(/draft/i);
});

test("an escalation rule can count the hours you work, and be switched back to every hour", async ({ owner }) => {
  await owner.goto("/tasks/escalation");
  await owner.getByLabel("Name", { exact: true }).fill(`Working hours rule ${run}`);
  await owner.getByLabel("Hours late").fill("12");
  await owner.getByLabel("Count only the hours you work").check();
  await owner.getByLabel("Tell").selectOption("role");
  await owner.getByLabel("Role (if a role)").selectOption("office_manager");
  await owner.getByRole("button", { name: "Add rule" }).click();
  const row = owner.getByRole("row", { name: new RegExp(`Working hours rule ${run}`) });
  await expect(row).toContainText("When a task is 12 working hours late, tell the office managers.");

  await row.getByRole("button", { name: "Count every hour" }).click();
  await expect(row).toContainText("When a task is 12 hours late, tell the office managers.");
  await row.getByRole("button", { name: "Count working hours" }).click();
  await expect(row).toContainText("12 working hours late");
});

/* ------------------------------------------------------------------ part days off */

const ZONE = "America/Chicago";
const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** A wall clock time on a day in Austin, as an instant. */
const clock = (day: string, hour: number) => {
  const local = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" })
    .formatToParts(local).find((p) => p.type === "timeZoneName")!.value;
  return new Date(local.getTime() - Number(offset.replace("GMT", "") || "0") * 3_600_000).toISOString();
};
const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
});

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a morning visit is moved to a day everybody has the afternoon off, because leave is read by the hour", async ({ owner }) => {
  test.setTimeout(180_000);
  /**
   * A Tuesday and the Wednesday after it, far enough out to be clear of the
   * other rebalance spec's days, the change order specs' visits and the crew
   * lane spec's day off, which whole day leave on the Wednesday would overlap.
   */
  let DAY = plus(companyToday(), 60);
  while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 2) DAY = plus(DAY, 1);
  const NEXT = plus(DAY, 1);

  const { locations } = await api<{ locations: { id: string; name: string }[] }>(owner, "get", "/v1/locations");
  const shop = locations.find((l) => l.name === "Shop") ?? locations[0]!;
  await api(owner, "post", `/v1/locations/${shop.id}/pin`, { latitude: 30.33, longitude: -97.72 });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const sam = technicians.find((t) => t.displayName === "Sam Reyes")!;
  for (const t of technicians) await api(owner, "patch", `/v1/technicians/${t.id}`, { homeLocationId: shop.id });

  /** Everybody but Sam is off the whole of the first day, so the overflow cannot go to somebody else. */
  for (const t of technicians.filter((x) => x.id !== sam.id)) {
    const off = await api<{ id: string }>(owner, "post", "/v1/time-off", {
      technicianId: t.id, startsAt: clock(DAY, 0), endsAt: clock(DAY, 23), reason: "Training",
    });
    await api(owner, "post", `/v1/time-off/${off.id}/approve`, {});
  }
  /** And everybody has the afternoon of the second day off: the morning is still theirs. */
  for (const t of technicians) {
    const off = await api<{ id: string }>(owner, "post", "/v1/time-off", {
      technicianId: t.id, startsAt: clock(NEXT, 12), endsAt: clock(NEXT, 17), reason: "Dentist",
    });
    await api(owner, "post", `/v1/time-off/${off.id}/approve`, {});
  }

  const visitIds: string[] = [];
  for (const [i, lng] of [-97.715, -97.71, -97.705, -97.70, -97.695].entries()) {
    const name = i === 4 ? `Morning flexible ${run}` : `Morning fixed ${i} ${run}`;
    const customerId = await newCustomer(owner, {
      name, address: { street: `${run.slice(-4)}${i} Half Day Rd`, city: "Austin", state: "TX", zip: "78723" },
    });
    const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
    await api(owner, "post", `/v1/properties/${data[0]!.id}/pin`, { latitude: 30.33, longitude: lng });
    const job = await api<{ visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
      customerId, propertyId: data[0]!.id, summary: `Two hour job ${i} ${run}`,
      visit: {
        windowStart: clock(DAY, 8), windowEnd: clock(DAY, i === 4 ? 11 : 17), estimatedDurationMinutes: 120, technicianIds: [sam.id],
      },
    });
    visitIds.push(job.visits[0]!.id);
  }
  const flexible = visitIds[4]!;

  await owner.goto(`/visits/${flexible}`);
  const agreed = owner.getByRole("region", { name: "Days it may move to" });
  await agreed.getByLabel("From").fill(DAY);
  await agreed.getByLabel("To").fill(NEXT);
  await agreed.getByRole("button", { name: "Save" }).click();
  await expect(agreed.getByRole("status")).toContainText("Saved.");

  await owner.goto(`/schedule?date=${DAY}`);
  await owner.getByRole("link", { name: "Rebalance several days" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Rebalance several days" })).toBeVisible();
  const moved = owner.getByRole("table", { name: "Moved to another day" });
  await expect(moved.getByRole("row").filter({ hasText: `Morning flexible ${run}` })).toContainText("A range of days");
  await expect(owner.getByRole("region", { name: longDay(NEXT) })).toContainText(`Morning flexible ${run}`);
});

test("the one reminder to a customer who did not answer is turned on from the reviews screen, and off again", async ({ owner }) => {
  const policy = await owner.request.put("/api/v1/reviews/policy", { data: { timeZone: "America/Chicago" } });
  expect(policy.ok(), await policy.text()).toBe(true);

  await owner.goto("/reviews");
  const reminders = owner.getByRole("region", { name: "Reminders" });
  await expect(reminders).toContainText("Off. Each customer is asked once.");
  await reminders.getByLabel(/Remind after this many days/).fill("5");
  await reminders.getByRole("button", { name: "Save" }).click();
  await expect(reminders).toContainText("On. If nobody has answered 5 days after the ask");
  await expect(reminders).toContainText("Nobody gets more than one.");
  const read = await owner.request.get("/api/v1/reviews/reminders");
  expect(((await read.json()) as { afterDays: number | null }).afterDays).toBe(5);

  // A gap that is a nag is refused in words.
  await reminders.getByLabel(/Remind after this many days/).fill("1");
  await reminders.getByRole("button", { name: "Save" }).click();
  await expect(reminders.getByRole("alert").filter({ hasText: /between 3 and 60/ })).toBeVisible();

  await reminders.getByLabel(/Remind after this many days/).fill("");
  await reminders.getByRole("button", { name: "Save" }).click();
  await expect(reminders).toContainText("Off. Each customer is asked once.");
});

test("a technician ticks a task's checklist and finishes it on /my-day, with a reason for what was left", async ({ owner, tech }) => {
  const people = await api<{ people: { userId: string; name: string }[] }>(owner, "get", "/v1/reporting-lines");
  const ray = people.people.find((p) => p.name === "Ray Ortiz")!;
  const title = `Van check ${run}`;
  const made = await api<{ id: string }>(owner, "post", "/v1/tasks", {
    title, assigneeUserId: ray.userId, checklist: ["Tyres", "Fluids", "Lights"],
  });

  await tech.goto("/my-day");
  await ready(tech);
  const panel = tech.getByRole("region", { name: "Tasks" });
  const card = panel.locator("div.rounded.border").filter({ hasText: title });
  await expect(card).toContainText("0 of 3 ticked");

  await card.getByLabel("Tyres").check();
  await expect(card).toContainText("1 of 3 ticked");
  await card.getByLabel("Tyres").uncheck();
  await card.getByLabel("Tyres").check();
  await card.getByLabel("Lights").check();
  await expect(card).toContainText("2 of 3 ticked");

  // One item is left, so finishing asks for a reason, in the office's words.
  await card.getByRole("button", { name: "Done", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("One item is not ticked. Tick it, or say why it is done anyway.");
  await card.getByLabel(`Why items are unticked, ${title}`).fill("Fluids topped up at the yard");
  await card.getByLabel(`What happened, ${title}`).fill("Van is fine");
  await card.getByRole("button", { name: "Done", exact: true }).click();
  await expect(tech.getByText(/All sent/)).toBeVisible();

  // And the office has it: the items ticked by Ray, the reason kept apart from the outcome.
  const list = await api<{ items: { label: string; done: boolean; doneBy: string | null }[]; overrideReason: string | null }>(
    owner, "get", `/v1/tasks/${made.id}/checklist`);
  expect(list.items.map((i) => [i.label, i.done])).toEqual([["Tyres", true], ["Fluids", false], ["Lights", true]]);
  expect(list.items[0]!.doneBy).toBe("Ray Ortiz");
  expect(list.overrideReason).toBe("Fluids topped up at the yard");
  await owner.goto(`/tasks/${made.id}`);
  await expect(owner.getByText("Fluids topped up at the yard").first()).toBeVisible();
});
