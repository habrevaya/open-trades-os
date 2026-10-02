import { test, expect, run, newCustomer } from "./fixtures";
import { accountLink, deliverScheduleNow } from "./deliveries";

/**
 * NUMBERS THAT OPEN, REPORTS THAT ARRIVE, STATEMENTS THAT GO OUT
 *
 * One real walk through each screen this added, as the seeded owner. The
 * arithmetic is proven in the service's tests: every built-in report and
 * dashboard tile, drilled row by row, adds up to what was clicked. What needs
 * a browser is that the number is a link, the link opens the records, the
 * forms post what they show, and the screens say afterwards what happened.
 *
 * The seeded company has no mail provider connected, on purpose, the same as
 * the booked-to-paid walk. So a report and a statement here are recorded as
 * not sent, with the reason, which is exactly what a company that has not set
 * up email yet would see, and the part of the promise ("every attempt is
 * written down") that a working mail server would hide.
 */

const iso = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const shown = (date: string) => new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
}).format(new Date(`${date}T12:00:00Z`));

test("Drill through: a number on a report opens the invoices behind it, and they add up to it", async ({ owner }) => {
  await owner.goto("/reports/built-in/ar-aging");
  const first = owner.locator("main table tbody tr").first();
  const link = first.getByRole("link").first();
  const clicked = (await link.innerText()).trim();
  await expect(link).toHaveAttribute("title", /^Open the records behind Outstanding, /);
  await link.click();

  await expect(owner).toHaveURL(/\/reports\/drill\?/);
  await expect(owner.getByRole("heading", { level: 1, name: "Invoices behind Receivables by age" })).toBeVisible();
  await expect(owner.getByRole("list", { name: "What this row is" })).toContainText("Age:");
  // The total under the Outstanding column is the number that was clicked.
  await expect(owner.getByRole("row", { name: "Total", exact: true })).toContainText(clicked);

  // Back to the report, with its dates, and on to one invoice.
  await expect(owner.getByRole("link", { name: "Back to Receivables by age" })).toHaveAttribute("href", "/reports/built-in/ar-aging");
  await owner.getByRole("table").getByRole("link", { name: /^Invoice \d+$/ }).first().click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
});

test("Drill through: a bar on a dashboard opens the records behind it", async ({ owner }) => {
  await owner.goto("/dashboards/money");
  await owner.getByTitle(/^Open the records behind Who owes us, /).first().click();
  await expect(owner.getByRole("heading", { level: 1, name: "Invoices behind Who owes us" })).toBeVisible();
  // The tile's own filter came with it, said in words.
  await expect(owner.getByText("Status is not Paid.")).toBeVisible();
  await expect(owner.getByRole("row", { name: "Total", exact: true })).toBeVisible();
});

test("Schedules: a report is scheduled from its page, delivered, paused, changed and stopped", async ({ owner }) => {
  const name = `Jobs each Monday ${run}`;
  const accountant = `books+${run}@accountant.test`;

  await owner.goto("/reports/built-in/jobs-by-status");
  await owner.getByRole("main").getByRole("link", { name: "Email on a schedule" }).click();
  await expect(owner).toHaveURL(/\/reports\/schedules\/new\?report=builtIn%3Ajobs-by-status$/);
  await expect(owner.getByLabel("Report")).toHaveValue("builtIn:jobs-by-status");
  await owner.getByLabel("Name it (optional)").fill(name);
  await owner.getByLabel("How often").selectOption("weekly");
  await owner.getByLabel("Anybody outside the company (your accountant)").fill(accountant);
  await owner.getByRole("button", { name: "Schedule it" }).click();

  await expect(owner).toHaveURL(/\/reports\/schedules$/);
  const row = owner.getByRole("listitem", { name });
  await expect(row).toContainText("Every Monday at 7:00 AM");
  await expect(row).toContainText("The seven days before");
  await expect(row).toContainText(accountant);
  await expect(row).toContainText("Nothing sent yet.");

  // The worker's pass, for this one schedule, now rather than on Monday.
  const tick = await deliverScheduleNow(name);
  expect(tick.action).toBe("delivered");
  await owner.reload();
  await expect(row).toContainText("Went to nobody");
  await expect(row).toContainText(`${accountant}: not sent, No email provider is connected`);

  await row.getByRole("button", { name: `Pause ${name}` }).click();
  await expect(row).toContainText("Paused");
  await row.getByRole("button", { name: `Resume ${name}` }).click();
  await expect(row).toContainText("Next:");

  await row.getByRole("link", { name: "Change" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Change "${name}"` })).toBeVisible();
  await owner.getByLabel("How often").selectOption("daily");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner).toHaveURL(/\/reports\/schedules$/);
  await expect(owner.getByRole("listitem", { name })).toContainText("Every day at 7:00 AM");

  await owner.getByRole("listitem", { name }).getByRole("button", { name: `Stop ${name} for good` }).click();
  await expect(owner.getByRole("listitem", { name })).toHaveCount(0);
});

test("Statements: one is emailed from the statement page, the refusal is kept, and the monthly run is switched on and off", async ({ owner }) => {
  const customer = `Stella Statement ${run}`;
  const address = `stella+${run}@example.test`;
  const id = await newCustomer(owner, { name: customer, email: address });

  await owner.goto(`/customers/${id}/statement`);
  const panel = owner.getByRole("region", { name: "Email statement" });
  await expect(panel.getByLabel("Email address")).toHaveAttribute("placeholder", address);
  await panel.getByRole("button", { name: "Email statement" }).click();
  await expect(panel.getByRole("alert").filter({ hasText: "No email provider is connected" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Statements already sent" })).toContainText(`to ${address}: not sent.`);

  await owner.goto("/invoices/statements");
  await expect(
    owner.getByRole("table", { name: "Statements sent" }).getByRole("row").filter({ hasText: customer }).first(),
  ).toContainText("Not sent.");

  const monthly = owner.getByRole("region", { name: "Monthly statements" });
  await expect(monthly).toContainText("Off.");
  await monthly.getByRole("checkbox").check();
  await monthly.getByLabel("Only if they owe more than ($)").fill("25");
  await monthly.getByRole("button", { name: "Save" }).click();
  await expect(monthly).toContainText("On. Every customer owing more than $25.00");
  await expect(monthly).toContainText("Next:");

  // Off again, so a later run of the suite starts where this one did.
  await monthly.getByRole("checkbox").uncheck();
  await monthly.getByRole("button", { name: "Save" }).click();
  await expect(monthly).toContainText("Off.");
});

test("A customer's statement opens on the period an emailed one names", async ({ owner, stranger }) => {
  const id = await newCustomer(owner, { name: `Paulo Period ${run}` });
  const path = await accountLink(id);
  const from = iso(-30);
  const to = iso(-2);
  await stranger.goto(`${path}/statement?from=${from}&to=${to}`);
  await expect(stranger.getByText(`${shown(from)} to ${shown(to)}`)).toBeVisible();

  // A period it cannot show falls back to the usual one rather than a 404.
  await stranger.goto(`${path}/statement?from=${from}&to=${iso(30)}`);
  await expect(stranger.getByText(`to ${shown(iso(0))}`)).toBeVisible();
});

test("The automation canvas: a step that runs and emails a report is drawn and saved", async ({ owner }) => {
  const name = `Receivables to the books ${run}`;
  await owner.goto("/automations/new");
  await owner.getByRole("textbox", { name: "Name" }).fill(name);
  await owner.getByRole("button", { name: "Remove step 1, Raise a task" }).click();
  await owner.getByRole("button", { name: "Add a step to the end" }).click();
  await owner.getByRole("button", { name: "Add Run and email a report" }).click();

  const card = owner.getByRole("region", { name: "step 1, Run and email a report" });
  await card.getByLabel("step 1, Run and email a report, report").selectOption("builtIn:ar-aging");
  await card.getByLabel("step 1, Run and email a report, which days it covers").selectOption("last_month");
  await card.getByLabel("step 1, Run and email a report, outside addresses").fill(`books+${run}@accountant.test`);

  await owner.getByRole("checkbox", { name: /invoice\.issued/ }).check();
  await owner.getByRole("button", { name: "Save, switched off" }).click();

  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  const saved = owner.getByRole("region", { name: "step 1, Run and email a report" });
  await expect(saved.getByLabel("step 1, Run and email a report, report")).toHaveValue("builtIn:ar-aging");
  await expect(saved.getByLabel("step 1, Run and email a report, which days it covers")).toHaveValue("last_month");
  await expect(saved.getByLabel("step 1, Run and email a report, outside addresses")).toHaveValue(`books+${run}@accountant.test`);
});
