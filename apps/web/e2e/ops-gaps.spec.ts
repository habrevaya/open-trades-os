import type { Locator, Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

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

/** A signature drawn with a finger's worth of strokes, as the selling spec does. */
async function sign(page: Page, pad: Locator, button: Locator) {
  await expect(async () => {
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + (2 * box.width) / 3, box.y + box.height - 20, { steps: 8 });
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await button.click();
}

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
