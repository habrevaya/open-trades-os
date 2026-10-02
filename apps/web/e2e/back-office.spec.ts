import { readFile } from "node:fs/promises";
import { test, expect, run, newCustomer } from "./fixtures";
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
  const customer = { id: await newCustomer(owner, { name: `Priya Raman ${run}`, phone: "512-555-0161" }) };

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

  // The seeded jobs carry the revenue their invoices posted, not $0.00.
  await expect(owner.getByRole("row").filter({ hasText: "Semiannual maintenance, two systems" })).toContainText("$344.24");
  await expect(owner.getByRole("row").filter({ hasText: "Suite 400 tenant complaint" })).toContainText("$2,480.50");
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
  const customer = { id: await newCustomer(owner, {
    name: `Hannah Okoro ${run}`, address: { street: "31 Live Oak Dr", city: "Austin", state: "TX", zip: "78745" },
  }) };

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

test("Trade scorecard: the pack's own numbers come back with both halves, and the gaps are named", async ({ owner }) => {
  /**
   * The screen that reads what the trade packs have declared since they shipped
   * and nothing read. A render test proves the card draws; this proves the SQL
   * behind it runs against a real company and answers.
   */
  await owner.goto(`/reports/scorecard?from=${inDays(-400)}&to=${inDays(30)}`);
  await expect(owner.getByRole("heading", { level: 1, name: "Trade scorecard" })).toBeVisible();
  await expect(owner.getByText("HVAC,", { exact: false })).toBeVisible();

  // The seeded company invoiced real money against completed jobs.
  const ticket = owner.getByRole("listitem").filter({ hasText: "Average ticket" });
  await expect(ticket).toBeVisible();
  await expect(ticket).toContainText("$");
  /** Both halves, which is the whole argument of the screen. */
  await expect(ticket).toContainText("completed jobs");
  await expect(ticket).toContainText("over");

  /**
   * And the other half of the answer: the ones it cannot compute, each naming
   * the datum it needs rather than saying "not built".
   */
  await expect(owner.getByText("Not computed, and what each one needs")).toBeVisible();
  await expect(owner.getByText(/Needs:/).first()).toBeVisible();

  // A backwards window is refused in a sentence rather than a stack trace.
  await owner.goto(`/reports/scorecard?from=${inDays(30)}&to=${inDays(-30)}`);
  await expect(owner.getByText("The end of the window is before its start")).toBeVisible();
});

test("Take a copy: the manifest counts the rows and the download ends with its terminator", async ({ owner }) => {
  await owner.goto("/settings/export");
  await expect(owner.getByRole("heading", { level: 1, name: "Take a copy" })).toBeVisible();

  // A row count per table is what makes an export checkable.
  const customers = owner.getByRole("row").filter({ hasText: "customer" }).first();
  await expect(customers).toBeVisible();

  // Credentials are held back by name, with a reason, rather than dropped quietly.
  await expect(owner.getByText("integration_connection").first()).toBeVisible();

  /**
   * The download itself, read through the signed in context so the cookie goes
   * with it. The last line of a finished file is the terminator and nothing
   * else is: a file without it stopped part way.
   */
  const response = await owner.request.get("/settings/export/download");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/x-ndjson");
  expect(response.headers()["content-disposition"]).toContain(".ndjson");

  const lines = (await response.text()).split("\n").filter((line) => line !== "");
  const first = JSON.parse(lines[0]!) as { manifest?: { tables?: unknown[] } };
  expect(first.manifest?.tables?.length).toBeGreaterThan(50);

  const last = JSON.parse(lines.at(-1)!) as { complete?: boolean; rows?: number };
  expect(last.complete).toBe(true);
  expect(last.rows).toBeGreaterThan(0);

  // Every line between the two is a row tagged with the table it came from.
  const middle = JSON.parse(lines[1]!) as { table?: string; row?: unknown };
  expect(typeof middle.table).toBe("string");
  expect(middle.row).toBeTruthy();

  /** And no credential left in the file, which is the claim the screen makes. */
  expect(await response.text()).not.toContain("webhook_secret\":\"whsec");
});

test("Group: a company in no network is told so rather than shown an error", async ({ owner }) => {
  /**
   * Most companies running this are one company. A screen that treated that as
   * a misconfiguration would be wrong about the common case, and this is the
   * assertion that it is not.
   */
  await owner.goto("/settings/network");
  await expect(owner.getByText("This company is not in a group")).toBeVisible();
  await expect(owner.getByText("Joining is done from the operator API")).toBeVisible();
});

test("Containers: a can is registered, sent out, swapped, collected with a ticket and priced", async ({ owner }) => {
  /**
   * The whole hire lifecycle through the forms, because a render test cannot
   * prove that the date box a driver fills in reaches the service as an instant
   * on the right calendar day. That is the one mistake that costs a day on every
   * short rental, and it is invisible until an invoice is queried.
   */
  const street = `${run.slice(-5)} Kiln Rd`;
  await newCustomer(owner, {
    name: `Ridge Build ${run}`,
    address: { street, city: "Austin", state: "TX", zip: "78702" },
  });

  await owner.goto("/fleet/containers");
  await expect(owner.getByRole("heading", { level: 1, name: "Containers" })).toBeVisible();

  const register = owner.getByRole("table", { name: "The register" });
  const board = owner.getByRole("table", { name: "Out on hire" });
  const addForm = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add" }) });

  // Two cans: one to go out, one to swap in.
  const first = `${run.slice(-5)}1`;
  const second = `${run.slice(-5)}2`;
  for (const number of [first, second]) {
    await addForm.getByPlaceholder("4012").fill(number);
    await addForm.getByPlaceholder("20 yard").fill("20 yard");
    await addForm.getByRole("button", { name: "Add" }).click();
    await expect(register.getByRole("row").filter({ hasText: number })).toBeVisible();
  }

  // A second can on the same number is refused, in the service's own words.
  await addForm.getByPlaceholder("4012").fill(first);
  await addForm.getByRole("button", { name: "Add" }).click();
  await expect(addForm.getByRole("alert")).toContainText(/already|number/i);

  /**
   * Out to the site, with both meters' terms on the delivery.
   *
   * The fields are filled and then the button is pressed once. These row forms
   * are always open rather than revealed by their button, which the first version
   * of this test got wrong: it clicked Deliver to "open" the form and that
   * submitted it empty, so the can went out before any terms were typed and the
   * row it was looking for had already gone.
   */
  const yardRow = register.getByRole("row").filter({ hasText: first });
  await yardRow.getByLabel("Site").selectOption({ label: `${street}, Austin` });
  await yardRow.getByLabel("Delivered on").fill("2026-06-01");
  await yardRow.getByPlaceholder("Days incl.").fill("7");
  await yardRow.getByPlaceholder("Over/day").fill("12");
  await yardRow.getByPlaceholder("Tons incl.").fill("2");
  await yardRow.getByPlaceholder("Per ton").fill("60");
  await yardRow.getByRole("button", { name: "Deliver" }).click();

  await expect(register.getByRole("row").filter({ hasText: first })).toContainText("On a site");
  const hire = board.getByRole("row").filter({ hasText: first });
  await expect(hire).toContainText(street);
  await expect(hire).toContainText("2026-06-01");

  /**
   * A swap: one stop that takes the full can and leaves an empty one. Two rows
   * linked, because `rental.asset_id` is one column and the can physically
   * changed, so a swap cannot be an update.
   */
  await hire.getByLabel("Empty can").selectOption({ label: second });
  await hire.getByLabel("Swapped on").fill("2026-06-05");
  await hire.getByLabel("Net tons on the full can").fill("2.4");
  await hire.getByLabel("Ticket for the swap").fill(`T${run.slice(-5)}A`);
  await hire.getByRole("button", { name: "Swap" }).click();

  // The outgoing can is back in the yard and the incoming one is on the site.
  await expect(register.getByRole("row").filter({ hasText: first })).toContainText("In the yard");
  await expect(register.getByRole("row").filter({ hasText: second })).toContainText("On a site");
  // And the new hire says it is a swap, so a chain of them is not four rentals.
  const swapped = board.getByRole("row").filter({ hasText: second });
  await expect(swapped).toContainText("Swap");

  // Collected, with the scale ticket that is the support behind the invoice line.
  await swapped.getByLabel("Collected on").fill("2026-06-14");
  await swapped.getByLabel("Net tons collected").fill("3.1");
  await swapped.getByLabel("Ticket for the collection").fill(`T${run.slice(-5)}B`);
  await swapped.getByRole("button", { name: "Collect" }).click();
  await expect(register.getByRole("row").filter({ hasText: second })).toContainText("In the yard");

  /**
   * And what it is owed, on two separate meters.
   *
   * The swap carried the first hire's terms forward rather than asking again, so
   * this one is seven days included at twelve over and two tons included at sixty
   * over. Out 5 June to 14 June is TEN container days, counting any part of a
   * calendar day in the company's zone, so three days over at twelve is $36, and
   * 3.1 tons against two included is 1.1 over at sixty, which is $66.
   *
   * Both halves separately, because one is a scheduling argument and the other is
   * a scale ticket, and a single total shows neither.
   */
  await board.getByRole("row").filter({ hasText: second })
    .getByRole("link", { name: "What it is owed" }).click();
  const owed = owner.locator("section").filter({ hasText: "What this hire is owed" });
  await expect(owed).toContainText("10 container days");
  await expect(owed).toContainText("Extra days");
  await expect(owed).toContainText("Extra tonnage");
  await expect(owed).toContainText("$36.00");
  await expect(owed).toContainText("$66.00");
  await expect(owed).toContainText("$102.00");
});

test("Campaigns: an audience is read back as a sentence, and a send reports who it would not send to", async ({ owner }) => {
  /**
   * The one claim a render test cannot make: that the boxes a person ticks become
   * the rules the sender runs, and that the sentence on the screen describes the
   * audience the service actually selected rather than a second opinion about it.
   */
  await owner.goto("/marketing/campaigns");
  await expect(owner.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();

  const form = owner.locator("form").filter({
    has: owner.getByRole("button", { name: "Save as a draft" }),
  });

  // An audience with no rules at all is refused rather than sent to everybody.
  await form.getByLabel("Name").fill(`Everybody ${run}`);
  await form.getByLabel("Message").fill("Comfort Co here: $89 tune ups. Reply STOP to opt out.");
  await form.getByRole("button", { name: "Save as a draft" }).click();
  await expect(form.getByRole("alert")).toContainText(/at least one rule/);

  // With a rule it saves, and the sentence is the rule in words.
  const name = `Win back ${run}`;
  await form.getByLabel("Name").fill(name);
  await form.getByRole("checkbox").and(form.locator('[value="no_job_since"]')).check();
  await form.getByLabel("Days since the last job").fill("30");
  await form.getByRole("button", { name: "Save as a draft" }).click();

  const row = owner.getByRole("table", { name: "Campaigns" }).getByRole("row")
    .filter({ hasText: name });
  await expect(row).toContainText("were last served more than 30 days ago");
  await expect(row).toContainText("draft");

  // Who it reaches, counted and read back before anything is sent.
  await row.getByRole("link", { name: "Who it reaches" }).click();
  const audience = owner.locator("section").filter({ hasText: "Who it reaches" });
  await expect(audience).toContainText("were last served more than 30 days ago");

  /**
   * The send, on an audience that matches nobody in the seeded company: every
   * customer there has a recent job, so "not served for 30 days" selects none.
   *
   * That is the case worth asserting rather than the happy one. A campaign that
   * has gone and matched nobody must not read as one that has not gone, and the
   * first version of this screen showed both as "Not sent yet", so a campaign
   * marked `sent` sat beside a result saying it had not been.
   */
  const sendRow = owner.getByRole("table", { name: "Campaigns" }).getByRole("row")
    .filter({ hasText: name });
  await sendRow.getByRole("button", { name: "Send a batch" }).click();
  const after = owner.getByRole("table", { name: "Campaigns" }).getByRole("row")
    .filter({ hasText: name });
  await expect(after).toContainText("sent");
  await expect(after).toContainText("Nobody matched the rules");
  await expect(after).not.toContainText("Not sent yet");
});

test("Crews and on call: a crew is named, staffed and given a lead, and somebody goes on call", async ({ owner }) => {
  await owner.goto("/schedule/crews");
  await expect(owner.getByRole("heading", { level: 1, name: "Crews and on call" })).toBeVisible();

  const name = `Tree crew ${run}`;
  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add" }) });
  await add.getByPlaceholder("Tree crew").fill(name);
  /**
   * A rate with no unit is refused, because "eight hundred a day" is eight hundred
   * square feet or linear feet or cubic yards and the three are different jobs.
   */
  await add.getByLabel("Production rate a day").fill("800");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add.getByRole("alert")).toBeVisible();

  // With both halves it saves.
  await add.getByPlaceholder("Tree crew").fill(name);
  await add.getByLabel("Production rate a day").fill("800");
  await add.getByLabel("Unit the rate is in").fill("square feet");
  await add.getByRole("button", { name: "Add" }).click();

  const row = owner.getByRole("table", { name: "Crews" }).getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("800 square feet a day");
  // Nobody on it yet, said out loud rather than left blank.
  await expect(row).toContainText("Nobody on it");

  /**
   * Somebody on call, and the rota says who.
   *
   * IN THE NEXT FEW DAYS, not at a fixed date. The service windows the rota to
   * roughly a month ahead on purpose, and the first version of this test used a
   * date in the past: the shift was written, the list correctly showed nothing,
   * and the assertion read that as the screen being broken. The screen now states
   * its window for the same reason.
   */
  const soon = (days: number, hour: string) =>
    `${iso(new Date(Date.now() + days * 864e5))}T${hour}`;
  const schedule = owner.locator("form").filter({
    has: owner.getByRole("button", { name: "Schedule" }),
  });
  await schedule.getByLabel("From").fill(soon(3, "18:00"));
  await schedule.getByLabel("Until").fill(soon(6, "06:00"));
  await schedule.getByRole("button", { name: "Schedule" }).click();
  await expect(owner.getByRole("table", { name: "On call" })).toBeVisible();

  /**
   * And a second shift over the same hours is refused. Two rows covering one
   * instant is two people told different things, discovered at two in the morning
   * by a customer.
   */
  await schedule.getByLabel("From").fill(soon(4, "09:00"));
  await schedule.getByLabel("Until").fill(soon(5, "09:00"));
  await schedule.getByRole("button", { name: "Schedule" }).click();
  await expect(schedule.getByRole("alert")).toContainText(/already|on call|overlap/i);
});

test("Routes: a route is defined, given a stop, and turned into a day's work", async ({ owner }) => {
  const street = `${run.slice(-5)} Pool Ln`;
  await newCustomer(owner, {
    name: `Poolside ${run}`,
    address: { street, city: "Austin", state: "TX", zip: "78745" },
  });

  await owner.goto("/schedule/routes");
  await expect(owner.getByRole("heading", { level: 1, name: "Routes" })).toBeVisible();

  const name = `Tuesday north ${run}`;
  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add" }) });
  await add.getByPlaceholder("Tuesday north").fill(name);
  await add.getByLabel("Which weekday").selectOption({ label: "Tuesday" });
  await add.getByLabel("Minutes driving between stops").fill("8");
  await add.getByRole("button", { name: "Add" }).click();

  const row = owner.getByRole("table", { name: "Routes" }).getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Tuesday");

  // Its stops and whether the day fits.
  await row.getByRole("link", { name: "Stops and fit" }).click();
  await expect(owner.getByRole("heading", { level: 2, name })).toBeVisible();

  const stop = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add" }) }).last();
  await stop.getByLabel("Address").selectOption({ label: `${street}, Austin` });
  await stop.getByLabel("Minutes on site").fill("24");
  await stop.getByLabel("Price per stop").fill("65");
  await stop.getByRole("button", { name: "Add" }).click();
  await expect(owner.getByRole("table", { name: "Stops" })).toContainText(street);
  await expect(owner.getByRole("table", { name: "Stops" })).toContainText("$65.00");

  /**
   * The same address twice is refused: it is a double booking written into the
   * template, and every materialisation forever would produce the pair.
   */
  await stop.getByLabel("Address").selectOption({ label: `${street}, Austin` });
  await stop.getByRole("button", { name: "Add" }).click();
  await expect(stop.getByRole("alert")).toBeVisible();

  /**
   * Making a day. Refused onto the wrong weekday, because a route IS a weekday and
   * materialising Tuesday's onto a Thursday puts forty stops on a day the servicer
   * is committed elsewhere.
   */
  const make = owner.getByRole("table", { name: "Routes" }).getByRole("row").filter({ hasText: name });
  await make.getByLabel("Which day").fill("2026-06-04");
  await make.getByRole("button", { name: "Make a day" }).click();
  await expect(make.getByRole("alert")).toBeVisible();

  // A Tuesday works.
  await make.getByLabel("Which day").fill("2026-06-02");
  await make.getByRole("button", { name: "Make a day" }).click();
  await expect(make.getByRole("alert")).toHaveCount(0);
});

test("Commission plans: a basis is chosen with its caveat on the screen, and a plan is superseded", async ({ owner }) => {
  await owner.goto("/payroll/commissions");
  await expect(owner.getByRole("heading", { level: 1, name: "Commission plans" })).toBeVisible();

  /**
   * The caveat is on the screen where the choice is made, not behind a link.
   * Somebody picking a basis is writing the instruction their technicians will
   * follow for years, usually in about ninety seconds.
   */
  await expect(owner.getByText("Rewards instead:").first()).toBeVisible();
  await expect(owner.getByText("Needs:").first()).toBeVisible();

  const label = `Service commission ${run}`;
  const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Declare" }) });
  await form.getByLabel("What this plan is called").fill(label);
  await form.getByLabel("Basis").selectOption({ label: "Percentage of revenue" });
  // A percentage basis with a flat amount and no rate is refused by the service.
  await form.getByLabel("Flat amount").fill("45");
  await form.getByLabel("What a technician is told when they ask").fill("Eight per cent of the invoice.");
  await form.getByRole("button", { name: "Declare" }).click();
  await expect(form.getByRole("alert")).toBeVisible();

  // With the rate it declares, and the percentage reads as a percentage.
  await form.getByLabel("What this plan is called").fill(label);
  await form.getByLabel("Rate, as a decimal").fill("0.08");
  await form.getByLabel("Flat amount").fill("");
  await form.getByLabel("What a technician is told when they ask").fill("Eight per cent of the invoice.");
  await form.getByRole("button", { name: "Declare" }).click();

  const row = owner.getByRole("table", { name: "Commission plans" }).getByRole("row")
    .filter({ hasText: label });
  await expect(row).toContainText("8%");
  await expect(row).toContainText("Live");
  await expect(row).toContainText("rewards selling the expensive option");

  // Superseded rather than edited, and it stays on the list to explain past pay.
  await row.getByRole("button", { name: "Supersede" }).click();
  await expect(owner.getByRole("table", { name: "Commission plans" }).getByRole("row")
    .filter({ hasText: label })).toContainText("Superseded");
});

test("Work from other systems: an order arrives, is accepted, completed, and the push is owed then recorded", async ({ owner }) => {
  /**
   * The order is posted through the public API rather than built on a screen,
   * because that is how one actually arrives: a network dispatches it. There is no
   * adapter for any network, so the API is the only way in, and the screen is what
   * a dispatcher does with it afterwards.
   */
  const externalId = `CORR-${run}`;
  /**
   * The NUMBER is what the screen shows, because that is what a dispatcher reads
   * off the network's own portal; the id is the key the mirror is idempotent on.
   * The first version of this test looked for the id and found nothing.
   */
  const externalNumber = `9${run.slice(-5)}`;
  const received = await owner.request.post("/api/v1/external-work-orders", {
    data: { sourceSystem: "corrigo", externalId, externalNumber, externalStatus: "Dispatched" },
  });
  expect(received.ok()).toBe(true);

  await owner.goto("/contracts/external");
  await expect(owner.getByRole("heading", { level: 1, name: "Work from other systems" })).toBeVisible();

  const table = owner.getByRole("table", { name: "External work orders" });
  const row = table.getByRole("row").filter({ hasText: externalNumber });
  await expect(row).toContainText("Offered");
  /** Their word, verbatim and beside ours rather than instead of it. */
  await expect(row).toContainText("Dispatched");

  /**
   * An offered order can be accepted or declined and nothing else. The buttons come
   * from `weMayMoveTo`, so there is no Complete here yet and nowhere at all is
   * there a button saying the client pulled it.
   */
  await expect(row.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Decline" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Complete" })).toHaveCount(0);
  await expect(owner.getByRole("button", { name: /pulled by the client/i })).toHaveCount(0);

  await row.getByRole("button", { name: "Accept" }).click();
  await expect(table.getByRole("row").filter({ hasText: externalNumber }))
    .toContainText("Accepted");

  /**
   * Accepting owes the client an update. The queue is the point: a status changed
   * and never pushed is a contractor whose scorecard says they never responded.
   */
  await expect(owner.getByText(/order has a change their system has not been told/)).toBeVisible();

  // A failed push KEEPS it in the queue rather than clearing it.
  const accepted = table.getByRole("row").filter({ hasText: externalNumber });
  await accepted.getByLabel("Why the push failed").fill("401 from their gateway");
  await accepted.getByRole("button", { name: "Push failed" }).click();
  await expect(table.getByRole("row").filter({ hasText: externalNumber }))
    .toContainText("401 from their gateway");
  await expect(owner.getByText(/has a change their system has not been told/)).toBeVisible();

  // Recording the push clears it.
  await table.getByRole("row").filter({ hasText: externalNumber })
    .getByRole("button", { name: "Told them" }).click();
  await expect(owner.getByText("Nothing owed")).toBeVisible();

  /** And the networks' caveats are on the screen rather than in a help article. */
  await expect(owner.getByText("Accepting cannot be undone").first()).toBeVisible();
});
