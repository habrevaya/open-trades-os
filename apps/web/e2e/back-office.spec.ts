import { readFile } from "node:fs/promises";
import { test, expect, run, api } from "./fixtures";
import { fakeCarrier, flushOutbox } from "./outbox";

/**
 * THE BACK OFFICE SCREENS, ONE REAL SUBMIT EACH
 *
 * Every one of these screens replaced an API call, and each has a render test
 * proving it draws. What a render test cannot prove is that the form posts,
 * the server action accepts what the form actually sends, and the screen
 * shows the result afterwards. That is the gap these close, one screen each,
 * as the seeded owner.
 */

const iso = (date: Date) => date.toISOString().slice(0, 10);
const inDays = (days: number) => iso(new Date(Date.now() + days * 864e5));

test("Messages: the office texts a customer, the thread shows it queued, and the outbox hands it to the carrier", async ({ owner }) => {
  const customer = await api<{ id: string }>(owner.request, "POST", "/v1/customers", {
    type: "residential", name: `Priya Raman ${run}`, phone: "512-555-0161",
  });

  await owner.goto(`/customers/${customer.id}`);
  const body = `Your part came in, we can fit you in Thursday. ${run}`;
  await owner.getByRole("textbox", { name: "Message" }).fill(body);
  await owner.getByRole("button", { name: "Send text" }).click();

  await expect(owner).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1, name: `Priya Raman ${run}` })).toBeVisible();
  const bubble = owner.getByRole("listitem").filter({ hasText: body });
  await expect(bubble).toContainText("queued");

  // The carrier: a fake one, injected the way the outbox's own tests do it.
  const carrier = fakeCarrier();
  const conversationId = owner.url().split("/").pop()!;
  const outcomes = await flushOutbox(conversationId, carrier.provider);
  expect(outcomes.filter((o) => o.status === "sent").length).toBeGreaterThanOrEqual(1);
  expect(carrier.sent.map((m) => m.body)).toContain(body);
  expect(carrier.sent.find((m) => m.body === body)!.to).toBe("+15125550161");

  await owner.reload();
  await expect(owner.getByRole("listitem").filter({ hasText: body })).not.toContainText("queued");

  // A second message in the same thread, through the reply box.
  const reply = `Or Friday morning if that suits better. ${run}`;
  await owner.getByRole("textbox", { name: "Reply" }).fill(reply);
  await owner.getByRole("button", { name: /^Send/ }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: reply })).toContainText("queued");
  await flushOutbox(conversationId, carrier.provider);
  expect(carrier.sent.map((m) => m.body)).toContain(reply);

  // And it is on the customer's page and in the inbox.
  await owner.goto("/inbox");
  await expect(owner.getByText(`Priya Raman ${run}`).first()).toBeVisible();
});

test("Job costing: the report's date range submits and keeps its rows", async ({ owner }) => {
  await owner.goto("/reports/built-in/job-costing");
  await owner.getByLabel("From").fill(inDays(-400));
  await owner.getByLabel("To").fill(inDays(30));
  await owner.getByRole("button", { name: "Apply" }).click();
  await expect(owner).toHaveURL(/from=.*to=/);
  await expect(owner.getByRole("columnheader", { name: "Revenue" })).toBeVisible();
  await expect(owner.locator("main table tbody tr").first()).toBeVisible();
});

test("Payroll: a period is added, closed, and exported as the CSV the bureau imports", async ({ owner }) => {
  // A Monday nobody else will have used, so a rerun does not overlap the last one.
  const weeks = Math.floor(Date.now() / 1000) % 2000;
  const start = new Date(Date.UTC(1990, 0, 1) + weeks * 7 * 864e5);
  const label = `E2E ${run}`;

  await owner.goto("/payroll");
  await owner.getByLabel("Name").fill(label);
  await owner.getByLabel("First day").fill(iso(start));
  await owner.getByLabel("Weeks").selectOption("1");
  await owner.getByRole("button", { name: "Add period" }).click();

  const period = owner.getByRole("link", { name: new RegExp(label) });
  await expect(period).toBeVisible();
  await period.click();
  await expect(owner).toHaveURL(/\/payroll\/[0-9a-f-]{36}$/);

  await owner.getByPlaceholder("Note, e.g. sent to the bureau").fill("Checked against the timesheets");
  await owner.getByRole("button", { name: "Close period" }).click();
  await expect(owner.getByText(/closed/i).first()).toBeVisible();

  const download = owner.waitForEvent("download");
  await owner.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`payroll-E2E-${run}.csv`);
  const csv = await readFile(await file.path(), "utf8");
  expect(csv.split("\n")[0]).toMatch(/,/);
  await expect(owner.getByRole("status")).toContainText(`Saved payroll-E2E-${run}.csv`);
});

test("Projects: a project is started for a customer, given a phase and a draw", async ({ owner }) => {
  const name = `Kitchen remodel ${run}`;
  const customer = await api<{ id: string }>(owner.request, "POST", "/v1/customers", {
    type: "residential", name: `Hannah Okoro ${run}`,
    property: { address: { line1: "31 Live Oak Dr", city: "Austin", state: "TX", postalCode: "78745", country: "US" } },
  });

  await owner.goto("/projects");
  await owner.getByRole("link", { name: "Start a project" }).click();
  await owner.getByLabel("Customer").selectOption(customer.id);
  await owner.getByRole("button", { name: "Next" }).click();
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Contract value").fill("48000.00");
  await owner.getByLabel("Starts").fill(inDays(7));
  await owner.getByRole("button", { name: "Start project" }).click();

  await expect(owner).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(name);

  await owner.getByPlaceholder("Rough-in", { exact: true }).fill("Demolition and rough-in");
  await owner.getByPlaceholder("Billing value").fill("18000.00");
  await owner.getByRole("button", { name: "Add phase" }).click();
  await expect(owner.getByText("Demolition and rough-in").first()).toBeVisible();

  await owner.getByPlaceholder("Deposit, 30% on rough-in…").fill("Deposit on signing");
  await owner.getByPlaceholder("or an amount").fill("5000.00");
  await owner.getByRole("button", { name: "Plan draw" }).click();
  await expect(owner.getByText("Deposit on signing").first()).toBeVisible();

  await owner.goto("/projects");
  await expect(owner.getByRole("link", { name: new RegExp(name) })).toBeVisible();
});

test("Certifications: a kind is added, recorded against a technician, and seen", async ({ owner }) => {
  const code = `E2E-${run}`.toUpperCase();
  const name = `Backflow tester ${run}`;

  await owner.goto("/certifications");
  await owner.getByPlaceholder("EPA-608").fill(code);
  await owner.getByPlaceholder("EPA 608 Universal").fill(name);
  await owner.getByPlaceholder("Issued by").fill("Texas Commission on Environmental Quality");
  await owner.getByPlaceholder("Valid months").fill("12");
  await owner.getByPlaceholder("Warn days ahead").fill("60");
  await owner.getByRole("button", { name: "Add kind" }).click();
  const kinds = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Kinds this company recognises" }) });
  await expect(kinds.getByRole("listitem").filter({ hasText: name })).toContainText(code);

  const record = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Record" }) });
  await record.locator('select[name="technicianId"]').selectOption({ label: "Ray Ortiz" });
  await record.locator('select[name="certificationTypeId"]').selectOption({ label: name });
  await record.getByPlaceholder("Licence number").fill(`BPAT-${run}`);
  await record.getByLabel("Issued").fill(inDays(-300));
  await record.getByLabel("Expires").fill(inDays(30));
  await record.getByRole("button", { name: "Record" }).click();

  // Thirty days out against a sixty day warning: it is due for renewal.
  const due = owner.locator('h2:text-is("Due for renewal") + *');
  await expect(due).toContainText("Ray Ortiz");
  await expect(due).toContainText(name);

  const holding = owner.getByRole("listitem").filter({ hasText: `BPAT-${run}` }).first();
  await holding.getByRole("button", { name: "I have seen the card" }).click();
  await expect(holding.getByRole("button", { name: "I have seen the card" })).toHaveCount(0);
});

test("Fleet: a van is put on the register, checked out to a technician and given a reading", async ({ owner }) => {
  const label = `Van ${run}`;

  await owner.goto("/fleet");
  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add", exact: true }) });
  await add.locator('select[name="kind"]').selectOption({ label: "Vehicle" });
  await add.getByPlaceholder("Van 3").fill(label);
  await add.getByPlaceholder("Plate, serial or VIN").fill(`TX-${run}`);
  await add.locator('select[name="meterUnit"]').selectOption({ label: "Miles" });
  await add.getByRole("button", { name: "Add", exact: true }).click();

  // On the register, which is the list with the controls; the same van is
  // also on the expiring list above it, for having no registration yet.
  const row = owner.getByRole("listitem")
    .filter({ has: owner.getByRole("button", { name: "Record reading" }) })
    .filter({ hasText: label });
  await expect(row).toHaveCount(1);

  await row.getByRole("combobox").first().selectOption({ label: "Ray Ortiz" });
  await row.getByRole("button", { name: "Check out" }).click();
  await expect(row).toContainText("Ray Ortiz");
  await expect(row.getByRole("button", { name: "Check in" })).toBeVisible();

  await row.getByPlaceholder("miles").fill("48211");
  await row.getByRole("button", { name: "Record reading" }).click();
  await expect(row).toContainText("48,211");
});

test("Compliance: a policy is put on file, and a filing is opened", async ({ owner }) => {
  const name = `General liability ${run}`;

  await owner.goto("/compliance");
  await owner.getByPlaceholder("Kind, e.g. liability_insurance").fill("liability_insurance");
  await owner.getByPlaceholder("General liability policy").fill(name);
  await owner.getByPlaceholder("Number").fill(`GL-${run}`);
  await owner.getByPlaceholder("Issued by").fill("Lone Star Mutual");
  await owner.locator('form:has(button:text("Put on file")) input[name="expiresOn"]').fill(inDays(20));
  await owner.getByLabel("Needed for work").check();
  await owner.getByRole("button", { name: "Put on file" }).click();
  const policy = owner.getByRole("listitem").filter({ hasText: name });
  await expect(policy).toBeVisible();
  await expect(policy.getByRole("button", { name: "Renew" })).toBeVisible();

  const filing = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Open a filing" }) });
  await filing.getByLabel("Due").fill(inDays(14));
  await filing.getByLabel("Period from").fill(inDays(-30));
  await filing.getByLabel("to").fill(inDays(-1));
  await filing.getByRole("button", { name: "Open a filing" }).click();
  await expect(owner.getByText("Nothing owed.")).toHaveCount(0);
  await expect(owner.getByRole("listitem").filter({ hasText: "Refrigerant addition and recovery record" })).toBeVisible();
});

test("Settings, Integrations: Stripe is connected by secret names, a pasted key is refused, and it is disconnected", async ({ owner }) => {
  await owner.goto("/settings/integrations");

  // A lead webhook is said to be an API call, not sent to a page with no form.
  await expect(owner.getByText("lead webhooks are set up there too")).toHaveCount(0);
  await expect(owner.getByText("POST /v1/lead-connectors")).toBeVisible();

  const stripe = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
  await stripe.getByRole("button", { name: "Connect Stripe" }).click();

  // The secret itself, pasted where its name belongs: refused, and not stored.
  // Assembled here so no literal that reads as a live key sits in the
  // repository for a secret scanner to stop at. It is not a key.
  const pasted = ["sk", "live", "e2e".repeat(8) + run].join("_");
  await stripe.getByPlaceholder("STRIPE_SECRET_KEY").fill(pasted);
  await stripe.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(stripe.getByRole("alert")).toBeVisible();
  await expect(stripe.getByRole("button", { name: "Disconnect" })).toHaveCount(0);

  // Names only.
  await stripe.getByPlaceholder("STRIPE_SECRET_KEY").fill("STRIPE_SECRET_KEY");
  await stripe.getByLabel("Publishable key").fill("pk_test_e2e");
  await stripe.getByLabel(/Webhook signing secret/).fill("STRIPE_WEBHOOK_SECRET");
  await stripe.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(stripe.getByRole("status")).toHaveText("Saved.");

  await owner.reload();
  const connected = owner.getByRole("listitem").filter({ hasText: "Stripe" }).first();
  await expect(connected.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(connected).not.toContainText(pasted);

  await connected.getByRole("button", { name: "Disconnect" }).click();
  await expect(connected.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
});
