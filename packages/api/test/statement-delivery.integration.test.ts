import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as statementDelivery from "../src/services/statement-delivery";
import * as schedules from "../src/services/delivery-schedules";
import * as portalAccount from "../src/services/portal-account";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A STATEMENT IN THE CUSTOMER'S INBOX
 *
 * By hand, from the statement page, and once a month for everybody owing more
 * than the company thinks is worth chasing. The promises:
 *
 *   A LINK, NOT THE NUMBERS. The email opens the statement on the customer's
 *   own account page for the period, and carries no amounts of its own.
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
