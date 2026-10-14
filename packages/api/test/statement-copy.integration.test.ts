import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as statementDelivery from "../src/services/statement-delivery";
import * as schedules from "../src/services/delivery-schedules";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { emailCustomerStatement, getStatementCopy, listStatementDeliveries } from "../src/contracts/statements";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A STATEMENT COPIED TO A SECOND PERSON
 *
 * A property manager's statement goes to its accounts clerk, and the owner
 * wants to see it too. The office's Email statement can copy one more of the
 * customer's own people, chosen from their list, and the customer record can
 * name one the monthly run copies. The promises:
 *
 *   ONLY THE PAYER'S OWN PEOPLE. A contact of another customer, one removed,
 *   or one with no address is refused when the office chooses, and when the
 *   monthly run finds the person named has gone since, no copy goes and the
 *   row says why. Nothing typed is ever copied.
 *
 *   A MESSAGE OF ITS OWN, by email, saying whose statement it is, only once
 *   the statement itself went: they share one link, and the link is revoked
 *   when the statement did not go.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("stcopy:org");
const USER = fixtureId("stcopy:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], grants: string[] = []): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles,
    ...(grants.length > 0 ? { grants: grants as NonNullable<Actor["grants"]> } : {}),
  },
  db: db(),
});
const owner = () => as(["owner"]);
/** Reads bills and statements, and sends none. */
const reader = () => as([], ["invoice:read", "customer:read"]);

let manager = "", stranger = "", noEmail = "";
let clerk = "", ownerPerson = "", noAddress = "", gone = "", strangersPerson = "";

const days = (n: number) => new Date(Date.parse(`${companyToday()}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function customer(name: string, email: string | null) {
  return (await customers.create(owner(), {
    type: "commercial", name, phone: "+15125558800", ...(email ? { email } : {}),
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  } as Parameters<typeof customers.create>[1])).id as string;
}

async function person(customerId: string, name: string, email: string | null, primary = false) {
  const [row] = await raw<{ id: string }[]>`insert into public.contact
    (organization_id, customer_id, name, phone, email, preferred_channel, is_primary)
    values (${ORG}, ${customerId}, ${name}, '+15125558801', ${email}, 'email', ${primary}) returning id`;
  return row!.id;
}

async function bill(customerId: string, amount: string) {
  await billing.create(owner(), {
    customerId, issuedOn: days(-40),
    lines: [{ name: "Work", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
}

const message = async (id: string | null) => id === null ? undefined : (await raw<{
  to_address: string; subject: string; body: string;
}[]>`select to_address, subject, body from public.message where id = ${id}`)[0];

const delivery = async (id: string) => (await raw<{
  message_id: string | null; copy_contact_id: string | null; copy_destination: string | null;
  copy_message_id: string | null; copy_error: string | null; period: string | null;
}[]>`select message_id, copy_contact_id, copy_destination, copy_message_id, copy_error, period
     from public.statement_delivery where id = ${id}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Copy Statement Co", slug: "statement-copy-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@copy.test" })})`;

  manager = await customer("Lakeside Property Management", "ap@lakeside.test");
  clerk = await person(manager, "Cora Clerk", "cora@lakeside.test", true);
  ownerPerson = await person(manager, "Otto Owner", "otto@lakeside.test");
  noAddress = await person(manager, "Ned Noaddress", null);
  gone = await person(manager, "Gil Gone", "gil@lakeside.test");
  await raw`update public.contact set deleted_at = now() where id = ${gone}`;

  stranger = await customer("Someone Else", "else@else.test");
  strangersPerson = await person(stranger, "Sam Stranger", "sam@else.test");
  noEmail = await customer("No Email Ltd", null);
  await person(noEmail, "Nina Named", "nina@noemail.test");

  await bill(manager, "500.00");
  await bill(noEmail, "75.00");
});

afterAll(async () => { if (raw) await raw.end(); });

run("a statement emailed by hand, copied to one more of the customer's people", () => {
  it("emails the copy as a message of its own, saying whose statement it is, with the same link", async () => {
    const sent = await statementDelivery.emailStatement(owner(), { id: manager, copyContactId: ownerPerson });
    expect(sent.state).toBe("queued");
    expect(sent.destination).toBe("ap@lakeside.test");
    expect(sent.copy).toEqual({
      contactId: ownerPerson, contactName: "Otto Owner", destination: "otto@lakeside.test", state: "queued", explanation: null,
    });

    const row = await delivery(sent.deliveryId);
    expect(row.copy_message_id).not.toBeNull();
    expect(row.copy_message_id).not.toBe(row.message_id);
    const copy = await message(row.copy_message_id);
    expect(copy!.to_address).toBe("otto@lakeside.test");
    expect(copy!.subject).toBe("A copy of Lakeside Property Management's statement from Copy Statement Co");
    expect(copy!.body).toContain("Hello Otto Owner,");
    expect(copy!.body).toContain(sent.portalUrl);
    expect(copy!.body).not.toMatch(/\$|500/);
    const files = await raw<{ n: number }[]>`select count(*)::int as n from public.message_attachment where message_id = ${row.copy_message_id}`;
    expect(files[0]!.n).toBe(1);

    /** The contract carries it, and the list says where the copy went. */
    expect(() => emailCustomerStatement.output.parse(sent)).not.toThrow();
    const [listed] = await statementDelivery.deliveries(owner(), { customerId: manager, limit: 1 });
    expect(listed).toMatchObject({ copyContactName: "Otto Owner", copyDestination: "otto@lakeside.test", copyError: null });
    expect(() => listStatementDeliveries.output.parse({
      deliveries: [{ ...listed!, createdAt: listed!.createdAt.toISOString() }],
    })).not.toThrow();
  });

  it("refuses a copy to somebody who is not this customer's, has gone, or has no address, before anything goes", async () => {
    const before = await raw<{ n: number }[]>`select count(*)::int as n from public.statement_delivery where customer_id = ${manager}`;
    await expect(statementDelivery.emailStatement(owner(), { id: manager, copyContactId: strangersPerson }))
      .rejects.toThrow("A copy can go only to one of this customer's own people. Choose one from their list.");
    await expect(statementDelivery.emailStatement(owner(), { id: manager, copyContactId: gone }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(statementDelivery.emailStatement(owner(), { id: manager, copyContactId: noAddress }))
      .rejects.toThrow("Ned Noaddress has no email address on file, so a copy cannot go to them.");
    const after = await raw<{ n: number }[]>`select count(*)::int as n from public.statement_delivery where customer_id = ${manager}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("sends no copy when the statement itself did not go, and says so", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: noEmail, copyContactId: (await statementDelivery.statementCopies(owner(), { id: noEmail })).candidates[0]!.id,
    });
    expect(sent.state).toBe("refused");
    expect(sent.copy).toMatchObject({ state: "refused", explanation: "The statement itself did not go, so neither did the copy." });
    expect((await delivery(sent.deliveryId)).copy_message_id).toBeNull();
  });

  it("sends no second email when the copy is to the address the statement went to", async () => {
    const sent = await statementDelivery.emailStatement(owner(), { id: manager, email: "cora@lakeside.test", copyContactId: clerk });
    expect(sent.state).toBe("queued");
    expect(sent.copy).toMatchObject({ state: "refused", explanation: "The statement went to Cora Clerk's own address, so no copy was needed." });
  });

  it("is the same send, copy and all, when the request is retried", async () => {
    const first = await statementDelivery.emailStatement({ ...owner(), idempotencyKey: "stcopy-replay" }, { id: manager, copyContactId: ownerPerson });
    const again = await statementDelivery.emailStatement({ ...owner(), idempotencyKey: "stcopy-replay" }, { id: manager, copyContactId: ownerPerson });
    expect(again.deliveryId).toBe(first.deliveryId);
    expect(again.copy).toMatchObject({ contactName: "Otto Owner", destination: "otto@lakeside.test", state: "queued" });
  });
});

run("the monthly run, copied to the person the customer record names", () => {
  async function monthlyRun(firstOf: string) {
    await schedules.setStatementSchedule(owner(), { enabled: true, dayOfMonth: 1, time: "08:00" });
    const [schedule] = await raw<{ id: string }[]>`
      select id from public.delivery_schedule where organization_id = ${ORG} and kind = 'statements'`;
    return inTenant(owner(), (tx) => statementDelivery.deliverStatements(tx, {
      organizationId: ORG, scheduleId: schedule!.id, at: new Date(`${firstOf}T14:00:00Z`), minimumBalance: "0",
    }));
  }
  const firstOfMonth = (after: number) => {
    const [y, m] = companyToday().split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 1 + after, 1)).toISOString().slice(0, 10);
  };
  const periodBefore = (firstOf: string) => new Date(Date.parse(`${firstOf}T00:00:00Z`) - 864e5).toISOString().slice(0, 7);
  const monthly = async (customerId: string, period: string) => (await raw<{ id: string }[]>`
    select id from public.statement_delivery where customer_id = ${customerId} and period = ${period}`)[0]!.id;

  it("names only one of the customer's own people with an address, under invoice:send, audited", async () => {
    await expect(statementDelivery.setStatementCopy(owner(), { id: manager, contactId: strangersPerson }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(statementDelivery.setStatementCopy(owner(), { id: manager, contactId: noAddress }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(statementDelivery.setStatementCopy(reader(), { id: manager, contactId: ownerPerson }))
      .rejects.toBeInstanceOf(PermissionError);

    const saved = await statementDelivery.setStatementCopy(owner(), { id: manager, contactId: ownerPerson });
    expect(saved).toEqual({ customerId: manager, contactId: ownerPerson, name: "Otto Owner" });
    const [audit] = await raw<{ action: string }[]>`select action from public.audit_log
      where organization_id = ${ORG} and entity_id = ${manager} and action = 'customer.statement_copy_set'`;
    expect(audit).toBeDefined();

    /** Whoever reads the statement sees who else gets it, and who it could go to. */
    const copies = await statementDelivery.statementCopies(reader(), { id: manager });
    expect(copies.monthly).toEqual({ contactId: ownerPerson, name: "Otto Owner", email: "otto@lakeside.test", usable: true });
    expect(copies.candidates.map((c) => c.name)).toEqual(["Cora Clerk", "Otto Owner"]);
    expect(() => getStatementCopy.output.parse(copies)).not.toThrow();
  });

  it("emails the named person a copy of each customer's monthly statement, once", async () => {
    const firstOf = firstOfMonth(-1);
    const result = await monthlyRun(firstOf);
    expect(result.copied).toBe(1);
    const row = await delivery(await monthly(manager, periodBefore(firstOf)));
    expect(row).toMatchObject({ copy_contact_id: ownerPerson, copy_destination: "otto@lakeside.test", copy_error: null });
    expect((await message(row.copy_message_id))!.to_address).toBe("otto@lakeside.test");

    /** Run again for the same month: nothing new goes, copy included. */
    const again = await monthlyRun(firstOf);
    expect(again).toMatchObject({ alreadySent: 2, copied: 0 });
  });

  it("copies nobody when the person named has been removed since, and says why", async () => {
    await statementDelivery.setStatementCopy(owner(), { id: manager, contactId: ownerPerson });
    await raw`update public.contact set deleted_at = now() where id = ${ownerPerson}`;
    try {
      expect((await statementDelivery.statementCopies(owner(), { id: manager })).monthly?.usable).toBe(false);
      const firstOf = firstOfMonth(0);
      const result = await monthlyRun(firstOf);
      expect(result.copied).toBe(0);
      const row = await delivery(await monthly(manager, periodBefore(firstOf)));
      expect(row.copy_message_id).toBeNull();
      expect(row.copy_error).toBe("Otto Owner has been removed from this customer, so no copy went.");
    } finally {
      await raw`update public.contact set deleted_at = null where id = ${ownerPerson}`;
    }
  });

  it("copies nobody when the customer names nobody", async () => {
    const cleared = await statementDelivery.setStatementCopy(owner(), { id: manager, contactId: null });
    expect(cleared.contactId).toBeNull();
    expect((await statementDelivery.statementCopies(owner(), { id: manager })).monthly).toBeNull();
  });
});
