import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import type { schema } from "@opentradesos/db";
import * as workflows from "../src/services/workflows";
import * as properties from "../src/services/properties";
import { emit } from "../src/services/events";
import { handleEvent } from "../src/services/workflow-runner";
import { stopUnless } from "../src/services/workflow-steps";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHAT THE CANVAS'S STEPS DO TO A CUSTOMER
 *
 * The report step sending a report to the customer an event is about, the
 * plain message step by email, and the questions a run can ask again after a
 * wait. The refusals come first in each block, because each of these is a way
 * for an automation to tell a customer something, and the failure that
 * matters is telling them something that is not theirs.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("steps:org");
const USER = fixtureId("steps:user");
const FROM = "office@steps-heating.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (over: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"], ...over }, db: db(),
});

/** Two customers with THE SAME NAME, so a report narrowed by name would leak one into the other. */
let alice = "";
let twin = "";
let other = "";
let noEmail = "";
let propertyId = "";
let invoiceNumber = 9000;

async function customer(name: string, email: string | null): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, email, phone)
    values (${ORG}, 'residential', ${name}, ${email}, null) returning id`;
  return row!.id;
}

async function invoice(customerId: string, total: string, status = "open"): Promise<string> {
  invoiceNumber += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.invoice (organization_id, number, customer_id, status, issued_on, due_on, total, balance)
    values (${ORG}, ${invoiceNumber}, ${customerId}, ${status}, current_date, current_date, ${total}, ${total})
    returning id`;
  return row!.id;
}

async function savedReport(name: string, definition: Record<string, unknown>): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.report (organization_id, name, definition)
    values (${ORG}, ${name}, ${raw.json(definition as never)}) returning id`;
  return row!.id;
}

/** An automation on `invoice.issued` with these steps, switched on. */
async function automation(steps: { kind: string; config: Record<string, unknown> }[], trigger = "invoice.issued") {
  const made = await workflows.create(owner(), {
    name: `Steps ${Math.random().toString(36).slice(2, 8)}`,
    triggerKind: "event", triggerEvents: [trigger], steps,
  });
  await workflows.setEnabled(owner(), { id: made.id, enabled: true });
  return made.id;
}

async function fire(name: "invoice.issued" | "job.created", payload: Record<string, unknown>, entity: { type: string; id: string }) {
  const event = await inTenant(owner(), (tx) => emit(tx, owner(), {
    name, entityType: entity.type, entityId: entity.id, payload,
  }));
  return handleEvent(owner(), event.id);
}

const emails = () => raw<{
  id: string; to_address: string; subject: string; body: string; body_html: string | null;
  automation_ref: string | null; purpose: string; from_address: string;
}[]>`
  select id, to_address, subject, body, body_html, automation_ref, purpose, from_address from public.message
  where organization_id = ${ORG} and channel = 'email' order by created_at`;

const attachments = (messageId: string) => raw<{ file_name: string; content: Buffer }[]>`
  select file_name, content from public.message_attachment where message_id = ${messageId} order by file_name`;

const stepRows = (runId: string) => raw<{ step_kind: string; status: string; error: string | null; output: Record<string, unknown> | null }[]>`
  select step_kind, status, error, output from public.workflow_step_run where run_id = ${runId} order by step_index`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Steps Heating", slug: "steps-heating" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: FROM })})`;
  alice = await customer("Sam Same", "alice@example.test");
  twin = await customer("Sam Same", "twin@example.test");
  other = await customer("Olga Other", "olga@example.test");
  noEmail = await customer("Nora Noemail", null);
  const property = await properties.create(owner(), {
    address: { line1: "1 Step Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: alice, customerRole: "owner",
  });
  propertyId = property.id;

  await invoice(alice, "100.0000");
  await invoice(alice, "250.0000", "paid");
  await invoice(twin, "7777.0000");
  await invoice(other, "999.0000");
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.report_delivery where organization_id = ${ORG}`;
  await raw`delete from public.report where organization_id = ${ORG}`;
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
  await raw`delete from public.message_attachment where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
});

/* -------------------------------------------------- a report to the customer */

run("emailing a report to the customer an event is about", () => {
  const byCustomer = { dataset: "invoices", dimensions: ["customer", "status"], measures: ["count", "total"] };
  const toCustomer = (report: string) => ({
    kind: "email_report", config: { report: `saved:${report}`, period: "all", to: "customer" },
  });

  it("refuses at publish a report about anything but the customer's own jobs, invoices, estimates or visits", async () => {
    const margin = await savedReport("Margin by customer", {
      dataset: "profitability", dimensions: ["customer"], measures: ["revenue"],
    });
    await expect(automation([toCustomer(margin)])).rejects.toThrow(/only be about their own jobs, invoices, estimates or visits/);
    const calls = await savedReport("Calls", { dataset: "calls", dimensions: [], measures: ["count"] });
    await expect(automation([toCustomer(calls)])).rejects.toThrow(/only be about their own/);
  });

  it("refuses at publish a column or filter that needs a permission, and one of the company's own fields", async () => {
    const value = await savedReport("Estimates by value", {
      dataset: "estimates", dimensions: ["status"], measures: ["value"],
    });
    await expect(automation([toCustomer(value)])).rejects.toThrow(/Value is for people in the company/);
    const ownField = await savedReport("By crew notes", {
      dataset: "invoices", dimensions: ["cf_crew_notes"], measures: ["count"],
    });
    await expect(automation([toCustomer(ownField)])).rejects.toThrow(ConflictError);
    await expect(automation([toCustomer(ownField)])).rejects.toThrow(/cf_crew_notes|own fields/);
  });

  it("refuses a copy to anybody else in the same step, and a clock that is about nobody", async () => {
    const report = await savedReport("Your invoices", byCustomer);
    await expect(automation([{
      kind: "email_report",
      config: { report: `saved:${report}`, period: "all", to: "customer", addresses: ["books@accountant.test"] },
    }])).rejects.toThrow(/goes to them alone/);
    await expect(workflows.create(owner(), {
      name: "Monday statements", triggerKind: "schedule", schedule: "0 9 * * 1", steps: [toCustomer(report)],
    })).rejects.toThrow(/about nobody in particular/);
  });

  it("sends the customer their own rows and never another customer's, even one with the same name", async () => {
    const report = await savedReport("Your invoices", byCustomer);
    await automation([toCustomer(report)]);
    const [summary] = await fire("invoice.issued", { invoiceId: fixtureId("inv"), customerId: alice }, { type: "invoice", id: fixtureId("inv") });
    expect(summary!.status).toBe("succeeded");

    const sent = await emails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to_address).toBe("alice@example.test");
    expect(sent[0]!.purpose).toBe("transactional");
    const files = await attachments(sent[0]!.id);
    const csv = files.find((f) => f.file_name.endsWith(".csv"))!.content.toString("utf8");
    // Alice's two invoices, open and paid, and nothing of her namesake's or anybody else's.
    expect(csv).toContain("100");
    expect(csv).toContain("250");
    expect(csv).not.toContain("7777");
    expect(csv).not.toContain("999");
    expect(csv).not.toContain("Olga");
    for (const text of [sent[0]!.body, sent[0]!.body_html ?? ""]) {
      expect(text).not.toContain("7777");
      expect(text).not.toContain("Olga");
      expect(text).not.toContain("/reports/");
    }
    const [delivery] = await raw<{ status: string; row_count: number; recipients: { address: string }[] }[]>`
      select status, row_count, recipients from public.report_delivery where organization_id = ${ORG}`;
    expect(delivery).toMatchObject({ status: "queued", row_count: 2 });
    expect(delivery!.recipients.map((r) => r.address)).toEqual(["alice@example.test"]);
  });

  it("sends nothing when the event names two different customers, rather than picking one", async () => {
    const report = await savedReport("Your invoices", byCustomer);
    await automation([toCustomer(report)]);
    const [summary] = await fire("invoice.issued", {
      invoiceId: fixtureId("inv2"), customerId: alice, invoice: { customerId: other },
    }, { type: "invoice", id: fixtureId("inv2") });
    expect(summary!.status).toBe("failed");
    expect((await stepRows(summary!.runId!))[0]!.error).toMatch(/more than one customer/);
    expect(await emails()).toEqual([]);
  });

  it("checks again on the day it runs, so a report edited after publish into the company's numbers is not sent", async () => {
    const report = await savedReport("Your invoices", byCustomer);
    await automation([toCustomer(report)]);
    await raw`update public.report set definition = ${raw.json({ dataset: "profitability", dimensions: ["customer"], measures: ["revenue"] })}
      where id = ${report}`;
    const [summary] = await fire("invoice.issued", { invoiceId: fixtureId("inv3"), customerId: alice }, { type: "invoice", id: fixtureId("inv3") });
    expect(summary!.status).toBe("failed");
    expect(await emails()).toEqual([]);
    const [delivery] = await raw<{ status: string; error: string }[]>`
      select status, error from public.report_delivery where organization_id = ${ORG}`;
    expect(delivery).toMatchObject({ status: "failed" });
    expect(delivery!.error).toMatch(/only be about their own/);
  });

  it("writes down a customer with no email address as nobody sent to, not a broken automation", async () => {
    const report = await savedReport("Your invoices", byCustomer);
    await automation([toCustomer(report)]);
    const [summary] = await fire("invoice.issued", { invoiceId: fixtureId("inv4"), customerId: noEmail }, { type: "invoice", id: fixtureId("inv4") });
    expect(summary!.status).toBe("succeeded");
    expect(await emails()).toEqual([]);
    const [delivery] = await raw<{ status: string; error: string }[]>`
      select status, error from public.report_delivery where organization_id = ${ORG}`;
    expect(delivery).toMatchObject({ status: "refused", error: "The customer has no email address." });
  });
});

/* ------------------------------------------------ the plain message by email */

run("the plain message step by email", () => {
  it("refuses a marketing email at publish: promotions go through campaigns", async () => {
    await expect(automation([{
      kind: "send_message", config: { channel: "email", purpose: "marketing", subject: "Sale", body: "Half off" },
    }], "job.created")).rejects.toThrow(/cannot be marketing/);
  });

  it("emails the customer through the email sender, from the company's address, with the subject filled in", async () => {
    await automation([{
      kind: "send_message",
      config: {
        channel: "email", purpose: "transactional",
        subject: "Your booking with {{ organization.name }}", body: "Hi {{ customer.name }}, we have you booked.",
      },
    }], "job.created");
    const [summary] = await fire("job.created", { job: { id: fixtureId("job-e"), customerId: alice } }, { type: "job", id: fixtureId("job-e") });
    expect(summary!.status).toBe("succeeded");
    const [sent] = await emails();
    expect(sent).toMatchObject({
      to_address: "alice@example.test", subject: "Your booking with Steps Heating",
      body: "Hi Sam Same, we have you booked.", from_address: FROM, purpose: "transactional",
      automation_ref: `run:${summary!.runId}`,
    });
  });

  it("does not send to a customer with no email, or one who is on the do not email list, and the run still succeeds", async () => {
    await automation([{ kind: "send_message", config: { channel: "email", subject: "Hi", body: "Hello" } }], "job.created");
    const [none] = await fire("job.created", { job: { id: fixtureId("job-n"), customerId: noEmail } }, { type: "job", id: fixtureId("job-n") });
    expect(none!.status).toBe("succeeded");
    expect((await stepRows(none!.runId!))[0]!.output).toMatchObject({ sent: false });

    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, 'olga@example.test', 'email', 'hard_bounce')`;
    try {
      const [suppressed] = await fire("job.created", { job: { id: fixtureId("job-s"), customerId: other } }, { type: "job", id: fixtureId("job-s") });
      expect(suppressed!.status).toBe("succeeded");
      expect((await stepRows(suppressed!.runId!))[0]!.output).toMatchObject({ sent: false, channel: "email" });
      expect(await emails()).toEqual([]);
    } finally {
      await raw`delete from public.suppression where organization_id = ${ORG}`;
    }
  });
});

/* ------------------------------------------------------- asking again */

run("the questions a run asks again after a wait", () => {
  type Event = typeof schema.domainEvent.$inferSelect;
  const eventAbout = (entityType: string, entityId: string, payload: Record<string, unknown> = {}) =>
    ({ entityType, entityId, payload, createdAt: new Date(), name: "x", id: fixtureId("e") }) as unknown as Event;
  const ask = (check: string, event: Event) =>
    inTenant(owner(), (tx) => stopUnless(tx, { check }, event, 2));

  it("refuses to guess when the event names nothing it can ask about", async () => {
    for (const check of ["invoice_unpaid", "visit_still_booked", "job_not_done"]) {
      const answer = await ask(check, eventAbout("customer", alice));
      expect(answer).toMatchObject({ ok: true, skipOffsets: [1, 2], output: { held: false } });
    }
  });

  it("an invoice: still owing holds; paid, voided or gone ends the run quietly", async () => {
    const owing = await invoice(alice, "40.0000");
    expect(await ask("invoice_unpaid", eventAbout("invoice", owing))).toMatchObject({ ok: true, output: { held: true } });
    await raw`update public.invoice set status = 'paid', balance = 0 where id = ${owing}`;
    const paid = await ask("invoice_unpaid", eventAbout("invoice", owing));
    expect(paid).toMatchObject({ ok: true, skipOffsets: [1, 2], output: { held: false } });
    expect(String((paid as { output: { because: string } }).output.because)).toMatch(/is paid now/);
    const voided = await invoice(alice, "40.0000", "void");
    expect(await ask("invoice_unpaid", eventAbout("x", "y", { invoiceId: voided }))).toMatchObject({ output: { held: false } });
  });

  it("a visit: still booked for the time the event said holds; cancelled or moved ends it", async () => {
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 8801, ${alice}, ${propertyId}, 'scheduled', 'Tune up') returning id`;
    const start = new Date(Date.now() + 2 * 86_400_000);
    const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'scheduled', ${start}, ${new Date(start.getTime() + 7_200_000)}, 120) returning id`;
    const event = eventAbout("visit", visit!.id, { visitId: visit!.id, windowStart: start.toISOString() });
    expect(await ask("visit_still_booked", event)).toMatchObject({ output: { held: true } });

    await raw`update public.visit set window_start = ${new Date(start.getTime() + 86_400_000)} where id = ${visit!.id}`;
    expect(await ask("visit_still_booked", event)).toMatchObject({ output: { held: false, because: "the visit was moved to another time" } });
    await raw`update public.visit set window_start = ${start}, status = 'cancelled' where id = ${visit!.id}`;
    expect(await ask("visit_still_booked", event)).toMatchObject({ output: { held: false, because: "the visit is cancelled now" } });
  });

  it("a job: open holds; finished or cancelled ends it", async () => {
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 8802, ${alice}, ${propertyId}, 'scheduled', 'Repair') returning id`;
    const event = eventAbout("job", job!.id, { job: { id: job!.id } });
    expect(await ask("job_not_done", event)).toMatchObject({ output: { held: true } });
    await raw`update public.job set status = 'completed' where id = ${job!.id}`;
    expect(await ask("job_not_done", event)).toMatchObject({ output: { held: false, because: "job #8802 is completed now" } });
  });

  it("refuses a question this build cannot ask, at publish", async () => {
    await expect(automation([{ kind: "stop_unless", config: { check: "customer_is_happy" } }]))
      .rejects.toThrow(/cannot check customer_is_happy/);
  });
});

/* ------------------------------------------------- the warranty call */

run("the recommended warranty call", () => {
  it("installs switched on, waiting on the warranty sweep, as an ordinary automation", async () => {
    const before = (await workflows.recommended(owner())).find((t) => t.key === "warranty_call")!;
    expect(before).toMatchObject({ installed: null, onForNewCompanies: false, blockedBy: null });

    const installed = await workflows.installTemplate(owner(), { key: "warranty_call", values: { days: 21 } });
    expect(installed).toMatchObject({ enabled: true, templateKey: "warranty_call" });
    const definition = await workflows.definition(owner(), { id: installed.id });
    expect(definition).toMatchObject({
      triggerKind: "dwell", dwell: { shape: "warranty_lapsing", afterDays: 21 },
      steps: [{ kind: "create_task" }],
    });
    await expect(workflows.installTemplate(owner(), { key: "warranty_call", values: {} }))
      .rejects.toThrow(/already installed/);
  });

  it("is not installed for a new company", async () => {
    const starters = await workflows.installStarters(owner());
    const keys = await raw<{ template_key: string }[]>`select template_key from public.workflow
      where id = any(${starters}::uuid[])`;
    expect(keys.map((k) => k.template_key)).not.toContain("warranty_call");
  });
});
