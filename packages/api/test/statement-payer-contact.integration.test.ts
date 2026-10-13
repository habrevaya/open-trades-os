import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as statementDelivery from "../src/services/statement-delivery";
import * as schedules from "../src/services/delivery-schedules";
import { ConflictError, UnprocessableError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A MONTHLY STATEMENT TO WHOEVER THE BILLS ARE ADDRESSED TO
 *
 * A property manager pays a tenant's bills, and the bills are addressed to
 * the manager's accounts clerk, who prefers texts. The monthly run sends the
 * manager's statement to the clerk, by text when texting is on and to the
 * clerk's own email when it is not, never to the main contact who booked the
 * work. A customer whose bills name nobody is sent it as before, by their main
 * contact's preference; one whose bills name two people is sent it by the
 * newest bill's, and the row says so. Who a bill is addressed to is one of the
 * payer's own people, on a bill still owed or paid, and nobody else.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("stpayer:org");
const USER = fixtureId("stpayer:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let manager = "", tenant = "", homeowner = "", twoPeople = "";
let clerk = "", booker = "", other = "", firstPerson = "", secondPerson = "";
let tenantBill = "";

const days = (n: number) => {
  const today = companyToday();
  return new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
};

async function customer(name: string, email: string, phone: string) {
  return (await customers.create(owner(), {
    type: "commercial", name, phone, email, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  } as Parameters<typeof customers.create>[1])).id as string;
}

async function person(customerId: string, name: string, phone: string, email: string, channel: "sms" | "email", primary: boolean) {
  const [row] = await raw<{ id: string }[]>`insert into public.contact
    (organization_id, customer_id, name, phone, email, preferred_channel, is_primary)
    values (${ORG}, ${customerId}, ${name}, ${phone}, ${email}, ${channel}, ${primary}) returning id`;
  return row!.id;
}

async function bill(customerId: string, amount: string, issuedOn: string, payer?: string) {
  const created = await billing.create(owner(), {
    customerId, issuedOn,
    lines: [{ name: "Work", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
  if (payer) await raw`update public.invoice set payer_customer_id = ${payer} where id = ${created.id as string}`;
  return created.id as string;
}

/** The first of this month, or of a month either side, as a date. */
function firstOfMonth(after: number): string {
  const [y, m] = companyToday().split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + after, 1)).toISOString().slice(0, 10);
}
const monthBefore = (firstOf: string) => new Date(Date.parse(`${firstOf}T00:00:00Z`) - 864e5).toISOString().slice(0, 7);

async function monthlyRun(textWhenPreferred: boolean, firstOf: string) {
  await schedules.setStatementSchedule(owner(), { enabled: true, dayOfMonth: 1, time: "08:00", textWhenPreferred });
  const [schedule] = await raw<{ id: string }[]>`
    select id from public.delivery_schedule where organization_id = ${ORG} and kind = 'statements'`;
  return inTenant(owner(), (tx) => statementDelivery.deliverStatements(tx, {
    organizationId: ORG, scheduleId: schedule!.id, at: new Date(`${firstOf}T14:00:00Z`),
    minimumBalance: "0", textWhenPreferred,
  }));
}

const sentFor = async (customerId: string, period: string) => (await raw<{
  channel: string; destination: string | null; contact_id: string | null; note: string | null; error: string | null;
}[]>`select channel, destination, contact_id, note, error from public.statement_delivery
     where organization_id = ${ORG} and customer_id = ${customerId} and period = ${period}`)[0];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Payer Statement Co", slug: "payer-statement-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@payer.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125557700', 'main', true)`;

  manager = await customer("Harbor Property Management", "front@harbor.test", "+15125557701");
  booker = await person(manager, "Mia Main", "+15125557702", "mia@harbor.test", "email", true);
  clerk = await person(manager, "Abe Accounts", "+15125557703", "abe@harbor.test", "sms", false);
  tenant = await customer("Tia Tenant", "tia@tenant.test", "+15125557704");
  other = await person(tenant, "Tia's partner", "+15125557705", "partner@tenant.test", "sms", true);

  homeowner = await customer("Hal Homeowner", "hal@home.test", "+15125557706");
  await person(homeowner, "Hal Homeowner", "+15125557707", "hal.contact@home.test", "email", true);

  twoPeople = await customer("Twin Peaks HOA", "board@twin.test", "+15125557708");
  firstPerson = await person(twoPeople, "Fay First", "+15125557709", "fay@twin.test", "email", true);
  secondPerson = await person(twoPeople, "Sid Second", "+15125557710", "sid@twin.test", "email", false);

  tenantBill = await bill(tenant, "240.00", days(-5), manager);
  await bill(homeowner, "150.00", days(-5));
  const older = await bill(twoPeople, "100.00", days(-9));
  const newer = await bill(twoPeople, "100.00", days(-4));
  await billing.setBillTo(owner(), { id: older, contactId: firstPerson });
  await billing.setBillTo(owner(), { id: newer, contactId: secondPerson });
});

afterAll(async () => { if (raw) await raw.end(); });

run("who a bill is addressed to", () => {
  it("is one of the payer's own people, or nobody in particular, and is audited", async () => {
    const addressed = await billing.setBillTo(owner(), { id: tenantBill, contactId: clerk });
    expect(addressed.payerContactId).toBe(clerk);
    /** The tenant's own contact is not the payer's: the manager pays. */
    await expect(billing.setBillTo(owner(), { id: tenantBill, contactId: other })).rejects.toBeInstanceOf(UnprocessableError);
    const [audit] = await raw<{ action: string }[]>`select action from public.audit_log
      where organization_id = ${ORG} and entity_id = ${tenantBill} and action = 'invoice.addressed'`;
    expect(audit).toBeDefined();
  });

  it("is refused on a void bill, and for somebody who may not write invoices", async () => {
    const throwaway = await bill(homeowner, "10.00", days(-1));
    await billing.voidInvoice(owner(), { id: throwaway, reason: "Raised twice" });
    await expect(billing.setBillTo(owner(), { id: throwaway, contactId: null })).rejects.toBeInstanceOf(ConflictError);
    await expect(billing.setBillTo(as(["technician"]), { id: tenantBill, contactId: booker })).rejects.toThrow();
  });
});

run("the monthly run, to whoever the bills are addressed to", () => {
  it("emails the clerk's own address, not the customer's or the main contact's, while texting is off", async () => {
    const result = await monthlyRun(false, firstOfMonth(-1));
    expect(result).toMatchObject({ owing: 3, queued: 3, texted: 0 });
    const period = monthBefore(firstOfMonth(-1));
    expect(await sentFor(manager, period)).toMatchObject({ channel: "email", destination: "abe@harbor.test", contact_id: clerk, note: null });
    /** A customer whose bills name nobody is sent it as before. */
    expect(await sentFor(homeowner, period)).toMatchObject({ channel: "email", destination: "hal@home.test", contact_id: null });
    /** The tenant pays nothing, so is sent nothing. */
    expect(await sentFor(tenant, period)).toBeUndefined();
  });

  it("texts the clerk, who prefers texts, once texting is on, though the main contact prefers email", async () => {
    const result = await monthlyRun(true, firstOfMonth(0));
    expect(result).toMatchObject({ owing: 3, queued: 3, texted: 1, emailedInstead: 0 });
    const period = monthBefore(firstOfMonth(0));
    expect(await sentFor(manager, period)).toMatchObject({ channel: "sms", destination: "+15125557703", contact_id: clerk });
    const listed = await statementDelivery.deliveries(owner(), { customerId: manager });
    expect(listed[0]).toMatchObject({ channel: "sms", contactName: "Abe Accounts" });
  });

  it("follows the newest bill when the bills name two people, and says so", async () => {
    const period = monthBefore(firstOfMonth(0));
    const sent = await sentFor(twoPeople, period);
    expect(sent).toMatchObject({ channel: "email", destination: "sid@twin.test", contact_id: secondPerson });
    expect(sent!.note).toBe("Their open bills are addressed to 2 people; it went to Sid Second, named on the newest.");
  });
});
