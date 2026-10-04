import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as statementDelivery from "../src/services/statement-delivery";
import * as schedules from "../src/services/delivery-schedules";
import * as portalAccount from "../src/services/portal-account";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A STATEMENT IN THE CUSTOMER'S INBOX
 *
 * By hand, from the statement page, and once a month for everybody owing more
 * than the company thinks is worth chasing. The promises:
 *
 *   A LINK, AND A DATED COPY. The email opens the statement on the customer's
 *   own account page for the period and carries no amounts in its text; the
 *   statement as it stood that day is attached as a PDF.
 *
 *   ONCE A MONTH, PER CUSTOMER, whatever the worker does.
 *
 *   WRITTEN DOWN when it did not go, with the reason: no address, suppressed,
 *   no email connected.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("stdel:org");
const USER = fixtureId("stdel:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});
const owner = () => as(["owner"]);

let owes = "";
let owesLittle = "";
let noEmail = "";
let paidUp = "";

const days = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function customer(name: string, emailAddress: string | null) {
  const created = await customers.create(owner(), {
    type: "residential", name, phone: "+15125550100",
    ...(emailAddress ? { email: emailAddress } : {}),
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  return created.id as string;
}

async function invoice(customerId: string, amount: string, issuedOn = days(-3)) {
  return billing.create(owner(), {
    customerId, issuedOn,
    lines: [{ name: "Work", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Statement Co", slug: "statement-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@statement.test" })})`;

  owes = await customer("Olive Owens", "olive@customer.test");
  owesLittle = await customer("Lenny Little", "lenny@customer.test");
  noEmail = await customer("Nora Nomail", null);
  paidUp = await customer("Pat Paid", "pat@customer.test");

  await invoice(owes, "300.00");
  await invoice(owesLittle, "30.00");
  await invoice(noEmail, "200.00");
  const paid = await invoice(paidUp, "80.00");
  await billing.pay({ ...owner(), idempotencyKey: `stdel-${Date.now()}` }, {
    customerId: paidUp, method: "cash", amount: "80.00", tipAmount: "0",
    allocations: [{ invoiceId: paid.id as string, amount: "80.00" }],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

const messageFor = (id: string) => raw<{ to_address: string; subject: string; body: string; body_html: string }[]>`
  select to_address, subject, body, body_html from public.message where id = ${id}`;

run("emailing a statement from the office", () => {
  it("sends a link to the customer's own statement, and no amounts", async () => {
    const sent = await statementDelivery.emailStatement(
      { ...owner(), idempotencyKey: "stdel-send-1" }, { id: owes },
    );
    expect(sent.state).toBe("queued");
    expect(sent.destination).toBe("olive@customer.test");
    expect(sent.portalUrl).toMatch(/\/c\/[A-Za-z0-9_-]+\/statement\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);

    const [row] = await raw<{ message_id: string; closing_balance: string; period: string | null }[]>`
      select message_id, closing_balance, period from public.statement_delivery where id = ${sent.deliveryId}`;
    expect(row!.period).toBeNull();
    expect(row!.closing_balance).toBe("300.0000");
    const [message] = await messageFor(row!.message_id);
    expect(message!.subject).toBe("Your statement from Statement Co");
    expect(message!.body).toContain(sent.portalUrl);
    // The balance is on the page they open, read when they open it, and not here.
    expect(message!.body).not.toMatch(/\$|300/);
    expect(message!.body_html).not.toMatch(/\$|300/);
  });

  it("attaches the statement as a PDF, dated, saying what is owed", async () => {
    const sent = await statementDelivery.emailStatement(owner(), { id: owes });
    const files = await raw<{ file_name: string; content_type: string; content: Buffer }[]>`
      select a.file_name, a.content_type, a.content from public.message_attachment a
      join public.statement_delivery d on d.message_id = a.message_id
      where d.id = ${sent.deliveryId}`;
    expect(files).toHaveLength(1);
    expect(files[0]!.file_name).toMatch(/^statement-olive-owens-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(files[0]!.content_type).toBe("application/pdf");
    const read = pdf.inspectPdf(new Uint8Array(files[0]!.content), (b) => new Uint8Array(inflateSync(b)));
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Statement Co");
    expect(read.text).toContain("Olive Owens");
    expect(read.text).toContain("As of");
    expect(read.text).toContain("Owed on invoices");
    expect(read.text).toContain("$300.00");
  });

  it("opens on the period the email named", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: owes, from: days(-30), to: days(-1),
    });
    const token = sent.portalUrl.split("/c/")[1]!.split("/")[0]!;
    const opened = await portalAccount.viewStatement(db(), { token, from: days(-30), to: days(-1) });
    expect(opened.customerName).toBe("Olive Owens");
    expect(opened.from).toBe(days(-30));
    expect(opened.closingBalance).toBe("300.0000");
  });

  it("is the same send when the request is retried", async () => {
    const again = await statementDelivery.emailStatement(
      { ...owner(), idempotencyKey: "stdel-send-1" }, { id: owes },
    );
    const [first] = await raw<{ id: string }[]>`
      select id from public.statement_delivery where organization_id = ${ORG} order by created_at limit 1`;
    expect(again.deliveryId).toBe(first!.id);
    expect(again.portalUrl).toBe("");
  });

  it("goes to an address the office types instead", async () => {
    const sent = await statementDelivery.emailStatement(owner(), { id: noEmail, email: "AP@Nora.test" });
    expect(sent).toMatchObject({ state: "queued", destination: "ap@nora.test" });
  });

  it("records a customer with no address as not sent, and says why", async () => {
    const sent = await statementDelivery.emailStatement(owner(), { id: noEmail });
    expect(sent.state).toBe("refused");
    expect(sent.explanation).toMatch(/no email address on file/);
  });

  it("records a suppressed address as not sent, and does not leave the link alive", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, 'lenny@customer.test', 'email', 'complaint')`;
    const sent = await statementDelivery.emailStatement(owner(), { id: owesLittle });
    expect(sent.state).toBe("refused");
    const [row] = await raw<{ portal_grant_id: string }[]>`
      select portal_grant_id from public.statement_delivery where id = ${sent.deliveryId}`;
    const [grant] = await raw<{ revoked_at: Date | null }[]>`
      select revoked_at from public.portal_grant where id = ${row!.portal_grant_id}`;
    expect(grant!.revoked_at).not.toBeNull();
    await raw`delete from public.suppression where organization_id = ${ORG}`;
  });

  it("refuses something that is not an address, and somebody who may not send bills", async () => {
    await expect(statementDelivery.emailStatement(owner(), { id: owes, email: "olive at home" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(statementDelivery.emailStatement(as(["technician"]), { id: owes })).rejects.toThrow();
  });

  it("lists what was sent for a customer, newest first, with the message's status", async () => {
    const listed = await statementDelivery.deliveries(owner(), { customerId: owes });
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed[0]!.messageStatus).toBe("queued");
    expect(listed[0]!.customerName).toBe("Olive Owens");
  });
});

run("monthly statements", () => {
  it("are off until somebody turns them on", async () => {
    expect(await schedules.statementSchedule(owner())).toMatchObject({ enabled: false, dayOfMonth: 1 });
  });

  it("plan the first run for the chosen day and time in the company's timezone", async () => {
    const set = await schedules.setStatementSchedule(owner(), {
      enabled: true, dayOfMonth: 1, time: "08:00", minimumBalance: "50",
    });
    expect(set.enabled).toBe(true);
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(set.nextRunAt!);
    expect(local).toBe("1, 8:00 AM");
  });

  it("send each customer owing more than the threshold one statement for last month, once", async () => {
    const [row] = await raw<{ id: string }[]>`
      select id from public.delivery_schedule where organization_id = ${ORG} and kind = 'statements'`;
    const firstOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 13));
    await raw`update public.delivery_schedule set next_run_at = ${firstOfMonth} where id = ${row!.id}`;

    const tick = await schedules.deliverOne(db(), ORG, row!.id, new Date());
    expect(tick.action).toBe("delivered");
    // Olive owes 300 and Nora 200; Lenny owes 30, under the 50 threshold; Pat owes nothing.
    expect(tick.statements).toMatchObject({ owing: 2, queued: 1, refused: 1, alreadySent: 0 });

    const sent = await raw<{ customer_id: string; period: string; destination: string | null; error: string | null }[]>`
      select customer_id, period, destination, error from public.statement_delivery
      where organization_id = ${ORG} and period is not null order by destination nulls last`;
    expect(sent.map((s) => s.customer_id).sort()).toEqual([owes, noEmail].sort());
    expect(sent[0]!.destination).toBe("olive@customer.test");
    expect(sent[1]!.error).toMatch(/no email address/);
    const month = new Date(firstOfMonth.getTime() - 864e5).toISOString().slice(0, 7);
    expect(sent.every((s) => s.period === month)).toBe(true);

    // The clock put back to the same occurrence: nobody gets a second one.
    await raw`update public.delivery_schedule set next_run_at = ${firstOfMonth} where id = ${row!.id}`;
    const again = await schedules.deliverOne(db(), ORG, row!.id, new Date());
    expect(again.statements).toMatchObject({ owing: 2, queued: 0, refused: 0, alreadySent: 2 });
    const count = await raw`select 1 from public.statement_delivery where organization_id = ${ORG} and period is not null`;
    expect(count).toHaveLength(2);
  });

  it("say on the setting that some customers were not sent one", async () => {
    const state = await schedules.statementSchedule(owner());
    expect(state.lastError).toBeNull(); // the repeat run refused nobody new
    expect(state.lastRunAt).not.toBeNull();
  });

  it("stop when turned off, and keep what they sent", async () => {
    const off = await schedules.setStatementSchedule(owner(), { enabled: false });
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    const due = await raw`
      select 1 from app.due_deliveries(1000) d
      join public.delivery_schedule s on s.id = d.schedule_id where s.organization_id = ${ORG}`;
    expect(due).toHaveLength(0);
    expect((await statementDelivery.deliveries(owner())).length).toBeGreaterThan(0);
  });

  it("refuse a threshold that is not an amount, and somebody who may not send bills", async () => {
    await expect(schedules.setStatementSchedule(owner(), { enabled: true, minimumBalance: "lots" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(schedules.setStatementSchedule(as(["dispatcher"]), { enabled: true })).rejects.toThrow();
  });
});

/**
 * BY TEXT, THROUGH THE ONE GATE EVERY TEXT GOES THROUGH
 *
 * Its own company, so the email runs above and the text runs here cannot
 * count each other's customers.
 */
run("statements by text", () => {
  const TEXT_ORG = fixtureId("stdel:text:org");
  const TEXT_USER = fixtureId("stdel:text:owner");
  const boss = (): ServiceContext => ({
    actor: { userId: TEXT_USER, organizationId: TEXT_ORG, roles: ["owner"] }, db: db(),
  });
  let texter = "", stopped = "", emailer = "", silent = "";

  /** A customer owing on an invoice, with a main contact who prefers `channel`. */
  async function owing(name: string, phone: string, emailAddress: string | null, channel: "sms" | "email" | null) {
    const created = await customers.create(boss(), {
      type: "residential", name, phone,
      ...(emailAddress ? { email: emailAddress } : {}),
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    if (channel) {
      await raw`insert into public.contact (organization_id, customer_id, name, phone, email, preferred_channel, is_primary)
                values (${TEXT_ORG}, ${created.id}, ${name}, ${phone}, ${emailAddress}, ${channel}, true)`;
    }
    await billing.create(boss(), {
      customerId: created.id, issuedOn: days(-3),
      lines: [{ name: "Work", quantity: "1", unitPrice: "180.00", discountAmount: "0", taxable: false }],
    });
    return created.id as string;
  }

  const texts = () => raw<{ to_address: string; body: string }[]>`
    select to_address, body from public.message
    where organization_id = ${TEXT_ORG} and channel = 'sms' and direction = 'outbound' order by created_at`;

  beforeAll(async () => {
    if (!url) return;
    await seedOrg(raw, { organizationId: TEXT_ORG, userId: TEXT_USER, name: "Text Statement Co", slug: "text-statement-co" });
    await raw`update public.organization set timezone = 'America/Chicago' where id = ${TEXT_ORG}`;
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
              values (${TEXT_ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@text.test" })})`;
    await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
              values (${TEXT_ORG}, '+15125558800', 'main', true)`;
    texter = await owing("Tess Texter", "+15125558801", "tess@customer.test", "sms");
    stopped = await owing("Stan Stopped", "+15125558802", "stan@customer.test", "sms");
    emailer = await owing("Edie Emailer", "+15125558803", "edie@customer.test", "email");
    silent = await owing("Sol Silent", "+15125558804", "sol@customer.test", null);
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${TEXT_ORG}, '+15125558802', 'sms', 'stop')`;
  });

  it("texts the link from the office, to the main contact's mobile, with no amounts", async () => {
    const sent = await statementDelivery.textStatement({ ...boss(), idempotencyKey: "stdel-text-1" }, { id: texter });
    expect(sent).toMatchObject({ state: "queued", channel: "sms", destination: "+15125558801", note: null });
    const [message] = (await texts()).slice(-1);
    expect(message!.to_address).toBe("+15125558801");
    expect(message!.body).toMatch(/^Hi Tess, it's Text Statement Co\. Your statement for /);
    expect(message!.body).toContain(sent.portalUrl);
    expect(message!.body).not.toMatch(/\$|180/);
    const [row] = await raw<{ channel: string }[]>`select channel from public.statement_delivery where id = ${sent.deliveryId}`;
    expect(row!.channel).toBe("sms");

    const again = await statementDelivery.textStatement({ ...boss(), idempotencyKey: "stdel-text-1" }, { id: texter });
    expect(again).toMatchObject({ deliveryId: sent.deliveryId, channel: "sms", portalUrl: "" });
  });

  it("goes to a number the office types instead", async () => {
    const sent = await statementDelivery.textStatement(boss(), { id: emailer, phone: "(512) 555-8899" });
    expect(sent).toMatchObject({ state: "queued", channel: "sms" });
    expect((await texts()).at(-1)!.to_address).toBe("+15125558899");
  });

  it("records a number that replied STOP as not texted, and does not leave the link alive", async () => {
    const before = (await texts()).length;
    const sent = await statementDelivery.textStatement(boss(), { id: stopped });
    expect(sent.state).toBe("refused");
    expect(sent.explanation).toBeTruthy();
    expect(await texts()).toHaveLength(before);
    const [row] = await raw<{ portal_grant_id: string; error: string }[]>`
      select portal_grant_id, error from public.statement_delivery where id = ${sent.deliveryId}`;
    expect(row!.error).toBe(sent.explanation);
    const [grant] = await raw<{ revoked_at: Date | null }[]>`
      select revoked_at from public.portal_grant where id = ${row!.portal_grant_id}`;
    expect(grant!.revoked_at).not.toBeNull();
  });

  it("refuses something that is not a phone number, and somebody who may not send bills", async () => {
    await expect(statementDelivery.textStatement(boss(), { id: texter, phone: "call me" }))
      .rejects.toBeInstanceOf(ConflictError);
    const technician: ServiceContext = {
      actor: { userId: TEXT_USER, organizationId: TEXT_ORG, roles: ["technician"] }, db: db(),
    };
    await expect(statementDelivery.textStatement(technician, { id: texter })).rejects.toThrow();
  });

  it("emails everybody on the monthly run until texting is turned on for it", async () => {
    const set = await schedules.setStatementSchedule(boss(), { enabled: true, dayOfMonth: 1, time: "08:00" });
    expect(set.textWhenPreferred).toBe(false);
    const result = await runInTenant(set.textWhenPreferred, firstOfMonth(-1));
    expect(result).toMatchObject({ owing: 4, texted: 0, emailedInstead: 0 });
    const rows = await raw<{ channel: string }[]>`
      select channel from public.statement_delivery
      where organization_id = ${TEXT_ORG} and period = ${monthBefore(firstOfMonth(-1))}`;
    expect(rows.map((r) => r.channel)).toEqual(["email", "email", "email", "email"]);
  });

  it("texts the customers who prefer texts when it is on, and emails a text that cannot go, saying so", async () => {
    const set = await schedules.setStatementSchedule(boss(), { enabled: true, textWhenPreferred: true });
    expect(set.textWhenPreferred).toBe(true);
    /** A month on from the run above, so each customer is owed a statement again. */
    const result = await runInTenant(true, firstOfMonth(0));
    expect(result).toMatchObject({ owing: 4, queued: 4, refused: 0, texted: 1, emailedInstead: 1 });

    const rows = await raw<{ customer_id: string; channel: string; destination: string; note: string | null }[]>`
      select customer_id, channel, destination, note from public.statement_delivery
      where organization_id = ${TEXT_ORG} and period = ${monthBefore(firstOfMonth(0))}`;
    const of = (id: string) => rows.find((r) => r.customer_id === id)!;
    expect(of(texter)).toMatchObject({ channel: "sms", destination: "+15125558801", note: null });
    expect(of(stopped)).toMatchObject({ channel: "email", destination: "stan@customer.test" });
    expect(of(stopped).note).toMatch(/^Not texted: .+ Emailed instead\.$/);
    expect(of(emailer)).toMatchObject({ channel: "email", note: null });
    expect(of(silent)).toMatchObject({ channel: "email", note: null });

    const listed = await statementDelivery.deliveries(boss(), { customerId: stopped });
    expect(listed[0]).toMatchObject({ channel: "email", note: of(stopped).note });
  });

  async function scheduleId(): Promise<string | undefined> {
    const [row] = await raw<{ id: string }[]>`
      select id from public.delivery_schedule where organization_id = ${TEXT_ORG} and kind = 'statements'`;
    return row?.id;
  }
  /** The run, inside the company's own transaction as the worker runs it, for the month before `firstOf`. */
  async function runInTenant(textWhenPreferred: boolean, firstOf: string) {
    const id = (await scheduleId())!;
    return inTenant({ actor: { userId: TEXT_USER, organizationId: TEXT_ORG, roles: ["owner"] }, db: db() }, (tx) =>
      statementDelivery.deliverStatements(tx, {
        organizationId: TEXT_ORG, scheduleId: id, at: new Date(`${firstOf}T14:00:00Z`),
        minimumBalance: "0", textWhenPreferred,
      }));
  }
  /** The first of this month, or of a month before it, as a date. A statement cannot run past today. */
  function firstOfMonth(after: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + after, 1)).toISOString().slice(0, 10);
  }
  /** `2026-09` for the first of October: the month a run on that day is about. */
  function monthBefore(firstOf: string): string {
    return new Date(Date.parse(`${firstOf}T00:00:00Z`) - 864e5).toISOString().slice(0, 7);
  }
});
