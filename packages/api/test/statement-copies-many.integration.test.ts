import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as statementDelivery from "../src/services/statement-delivery";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { emailCustomerStatement, listStatementDeliveries, textCustomerStatement } from "../src/contracts/statements";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A STATEMENT COPIED TO SEVERAL PEOPLE, BY TEXT AS WELL AS EMAIL, AND TO AN ADDRESS TYPED
 *
 * The office can copy a statement to up to five of the payer's own people, each
 * by email or by text, and to an address it types. Each copy is a message of its
 * own, held to its own channel's rules (a number that replied STOP is refused
 * with the reason and the rest still go), and only once the statement itself
 * went. A typed address is audited with the address.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("stcopies:org");
const USER = fixtureId("stcopies:owner");
const OUR_NUMBER = "+15125550177";

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
const reader = () => as([], ["invoice:read", "customer:read"]);

let manager = "", noEmail = "";
let clerk = "", ownerPerson = "", landline = "", noAddress = "", strangersPerson = "";

const days = (n: number) => new Date(Date.parse(`${companyToday()}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function customer(name: string, email: string | null) {
  return (await customers.create(owner(), {
    type: "commercial", name, phone: "+15125558800", ...(email ? { email } : {}),
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  } as Parameters<typeof customers.create>[1])).id as string;
}

async function person(customerId: string, name: string, email: string | null, phone: string | null, primary = false) {
  const [row] = await raw<{ id: string }[]>`insert into public.contact
    (organization_id, customer_id, name, phone, email, preferred_channel, is_primary)
    values (${ORG}, ${customerId}, ${name}, ${phone}, ${email}, 'email', ${primary}) returning id`;
  return row!.id;
}

async function bill(customerId: string, amount: string) {
  await billing.create(owner(), {
    customerId, issuedOn: days(-40),
    lines: [{ name: "Work", quantity: "1", unitPrice: amount, discountAmount: "0", taxable: false }],
  });
}

const copyRows = (deliveryId: string) => raw<{
  recipient_name: string | null; channel: string; destination: string | null; typed: boolean;
  message_id: string | null; error: string | null; contact_id: string | null;
}[]>`select recipient_name, channel, destination, typed, message_id, error, contact_id
       from public.statement_delivery_copy where statement_delivery_id = ${deliveryId} order by position`;
const messageOf = async (id: string | null) => id === null ? undefined : (await raw<{
  to_address: string; subject: string | null; body: string; channel: string; direction: string;
}[]>`select to_address, subject, body, channel::text as channel, direction::text as direction from public.message where id = ${id}`)[0];
const deliveryCount = async (customerId: string) =>
  (await raw`select 1 from public.statement_delivery where customer_id = ${customerId}`).length;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Copies Statement Co", slug: "statement-copies-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@copies.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, ${OUR_NUMBER}, 'main', true)`;

  manager = await customer("Harbor Property Management", "ap@harbor.test");
  clerk = await person(manager, "Cora Clerk", "cora@harbor.test", "+15125558811", true);
  ownerPerson = await person(manager, "Otto Owner", "otto@harbor.test", "+15125558812");
  landline = await person(manager, "Lena Landline", "lena@harbor.test", null);
  noAddress = await person(manager, "Ned Noaddress", null, "+15125558813");
  const stranger = await customer("Someone Else", "else@else.test");
  strangersPerson = await person(stranger, "Sam Stranger", "sam@else.test", "+15125558814");
  noEmail = await customer("No Email Ltd", null);
  await person(noEmail, "Nina Named", "nina@noemail.test", "+15125558815");

  await bill(manager, "500.00");
  await bill(noEmail, "75.00");
});

afterAll(async () => { if (raw) await raw.end(); });

run("several copies, by email and by text", () => {
  it("copies the statement to more than one of the payer's people, each by the channel chosen, as a message of its own", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: manager,
      copies: [
        { contactId: ownerPerson, channel: "email" },
        { contactId: clerk, channel: "sms" },
        { contactId: ownerPerson, channel: "sms" },
      ],
    });
    expect(sent.state).toBe("queued");
    expect(sent.copies).toEqual([
      { contactId: ownerPerson, contactName: "Otto Owner", channel: "email", destination: "otto@harbor.test", typed: false, state: "queued", explanation: null },
      { contactId: clerk, contactName: "Cora Clerk", channel: "sms", destination: "+15125558811", typed: false, state: "queued", explanation: null },
      { contactId: ownerPerson, contactName: "Otto Owner", channel: "sms", destination: "+15125558812", typed: false, state: "queued", explanation: null },
    ]);
    // The first of them is the one the old single field says.
    expect(sent.copy).toEqual({
      contactId: ownerPerson, contactName: "Otto Owner", destination: "otto@harbor.test", state: "queued", explanation: null,
    });

    const rows = await copyRows(sent.deliveryId);
    expect(rows.map((r) => [r.channel, r.destination, r.typed])).toEqual([
      ["email", "otto@harbor.test", false], ["sms", "+15125558811", false], ["sms", "+15125558812", false],
    ]);
    const text = await messageOf(rows[1]!.message_id);
    expect(text).toMatchObject({ channel: "sms", direction: "outbound", to_address: "+15125558811" });
    expect(text!.body).toBe(
      `Hi Cora, it's Copies Statement Co. A copy of Harbor Property Management's statement for `
      + `${text!.body.match(/for (.+?) is ready/)![1]} is ready to view: ${sent.portalUrl}`);
    expect(text!.body).not.toMatch(/\$|500/);
    const mail = await messageOf(rows[0]!.message_id);
    expect(mail).toMatchObject({ channel: "email", to_address: "otto@harbor.test" });
    expect(mail!.body).toContain("Hello Otto Owner,");
    // All of them are distinct messages, none the statement's own.
    expect(new Set(rows.map((r) => r.message_id)).size).toBe(3);

    // The list says where every one went; the old columns keep the first.
    const [listed] = await statementDelivery.deliveries(owner(), { customerId: manager, limit: 1 });
    expect(listed!.copies.map((c) => [c.contactName, c.channel, c.destination, c.typed])).toEqual([
      ["Otto Owner", "email", "otto@harbor.test", false], ["Cora Clerk", "sms", "+15125558811", false], ["Otto Owner", "sms", "+15125558812", false],
    ]);
    expect(listed).toMatchObject({ copyContactName: "Otto Owner", copyDestination: "otto@harbor.test" });
    expect(() => emailCustomerStatement.output.parse(sent)).not.toThrow();
    expect(() => listStatementDeliveries.output.parse({
      deliveries: [{ ...listed!, createdAt: listed!.createdAt.toISOString() }],
    })).not.toThrow();
  });

  it("copies a statement that was texted, by email and by text", async () => {
    const sent = await statementDelivery.textStatement(owner(), {
      id: manager, copies: [{ contactId: clerk, channel: "email" }, { contactId: ownerPerson, channel: "sms" }],
    });
    expect(sent).toMatchObject({ state: "queued", channel: "sms" });
    expect(sent.copies.map((c) => [c.channel, c.state])).toEqual([["email", "queued"], ["sms", "queued"]]);
    expect(() => textCustomerStatement.output.parse(sent)).not.toThrow();
  });

  it("refuses before anything goes: a stranger's person, no number, no address, more than five, both or neither", async () => {
    const before = await deliveryCount(manager);
    const ask = (copies: Parameters<typeof statementDelivery.emailStatement>[1]["copies"]) =>
      statementDelivery.emailStatement(owner(), { id: manager, copies });
    await expect(ask([{ contactId: strangersPerson, channel: "sms" }]))
      .rejects.toThrow("A copy can go only to one of this customer's own people. Choose one from their list.");
    await expect(ask([{ contactId: landline, channel: "sms" }]))
      .rejects.toThrow("Lena Landline has no mobile number on file, so a text copy cannot go to them.");
    await expect(ask([{ contactId: noAddress, channel: "email" }]))
      .rejects.toThrow("Ned Noaddress has no email address on file, so a copy cannot go to them.");
    await expect(ask(Array.from({ length: 6 }, (_, i) => ({ address: `p${i}@x.test`, channel: "email" as const }))))
      .rejects.toThrow("at most");
    await expect(ask([{ contactId: clerk, address: "a@b.test", channel: "email" }])).rejects.toThrow(/not both and not neither/);
    await expect(ask([{ channel: "email" }])).rejects.toThrow(/not both and not neither/);
    await expect(ask([{ address: "not an address", channel: "email" }])).rejects.toThrow('"not an address" is not an email address.');
    await expect(ask([{ address: "555-0100", channel: "sms" }])).rejects.toThrow(/is not a phone number a text can go to/);
    expect(await deliveryCount(manager)).toBe(before);
  });

  it("is invoice:send's, and the transport's permission is not asked of the person", async () => {
    await expect(statementDelivery.emailStatement(reader(), { id: manager, copies: [{ contactId: clerk, channel: "email" }] }))
      .rejects.toBeInstanceOf(PermissionError);
    // Somebody who may send statements and may not text customers can still copy by text, as they can text the statement.
    const finance = as([], ["invoice:read", "invoice:send", "customer:read"]);
    const sent = await statementDelivery.emailStatement(finance, { id: manager, copies: [{ contactId: clerk, channel: "sms" }] });
    expect(sent.copies[0]).toMatchObject({ channel: "sms", state: "queued" });
  });

  it("sends the others when one number replied STOP, and says why for that one", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, '+15125558812', 'sms', 'stop')`;
    try {
      const sent = await statementDelivery.emailStatement(owner(), {
        id: manager, copies: [{ contactId: ownerPerson, channel: "sms" }, { contactId: clerk, channel: "sms" }, { contactId: ownerPerson, channel: "email" }],
      });
      expect(sent.state).toBe("queued");
      expect(sent.copies.map((c) => c.state)).toEqual(["refused", "queued", "queued"]);
      expect(sent.copies[0]!.explanation).toMatch(/STOP/);
      expect(sent.copy).toMatchObject({ state: "refused" });
      const rows = await copyRows(sent.deliveryId);
      expect(rows[0]).toMatchObject({ message_id: null });
      expect(rows[0]!.error).toMatch(/STOP/);
    } finally {
      await raw`delete from public.suppression where organization_id = ${ORG}`;
    }
  });

  it("sends no copy when the statement itself did not go", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: noEmail, copies: [{ address: "boss@noemail.test", channel: "email" }, { address: "+15125550123", channel: "sms" }],
    });
    expect(sent.state).toBe("refused");
    expect(sent.copies.map((c) => [c.state, c.explanation])).toEqual([
      ["refused", "The statement itself did not go, so neither did the copy."],
      ["refused", "The statement itself did not go, so neither did the copy."],
    ]);
    expect((await copyRows(sent.deliveryId)).every((r) => r.message_id === null)).toBe(true);
  });

  it("copies nobody twice, and nobody who already has the statement", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: manager, email: "cora@harbor.test",
      copies: [
        { contactId: clerk, channel: "email" },
        { contactId: ownerPerson, channel: "email" },
        { address: "OTTO@harbor.test", channel: "email" },
      ],
    });
    expect(sent.copies).toHaveLength(2);
    expect(sent.copies[0]).toMatchObject({ contactName: "Cora Clerk", state: "refused", explanation: "The statement went to Cora Clerk's own address, so no copy was needed." });
    expect(sent.copies[1]).toMatchObject({ contactName: "Otto Owner", state: "queued" });
  });

  it("is the same send, copies and all, when the request is retried", async () => {
    const input = { id: manager, copies: [{ contactId: ownerPerson, channel: "email" as const }, { contactId: clerk, channel: "sms" as const }] };
    const first = await statementDelivery.emailStatement({ ...owner(), idempotencyKey: "stcopies-replay" }, input);
    const again = await statementDelivery.emailStatement({ ...owner(), idempotencyKey: "stcopies-replay" }, input);
    expect(again.deliveryId).toBe(first.deliveryId);
    expect(again.copies).toEqual(first.copies);
    expect(await copyRows(first.deliveryId)).toHaveLength(2);
  });

  it("lists who could be texted a copy beside who could be emailed one", async () => {
    const people = await statementDelivery.statementCopies(reader(), { id: manager });
    expect(people.candidates.map((c) => c.name)).toEqual(["Cora Clerk", "Lena Landline", "Otto Owner"]);
    expect(people.textCandidates.map((c) => [c.name, c.phone])).toEqual([
      ["Cora Clerk", "+15125558811"], ["Ned Noaddress", "+15125558813"], ["Otto Owner", "+15125558812"],
    ]);
  });
});

run("a copy to an address the office types", () => {
  it("goes to it by email or by text, is marked as typed, and is audited with the address", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: manager,
      copies: [{ address: "  Boss@Harbor-Owners.test ", channel: "email" }, { address: "(512) 555-0199", channel: "sms" }],
    });
    expect(sent.copies).toEqual([
      { contactId: null, contactName: null, channel: "email", destination: "boss@harbor-owners.test", typed: true, state: "queued", explanation: null },
      { contactId: null, contactName: null, channel: "sms", destination: "(512) 555-0199", typed: true, state: "queued", explanation: null },
    ]);
    const rows = await copyRows(sent.deliveryId);
    expect(rows.every((r) => r.typed && r.contact_id === null)).toBe(true);
    const mail = await messageOf(rows[0]!.message_id);
    expect(mail!.body.startsWith("Hello,\n")).toBe(true);
    expect(mail!.subject).toBe("A copy of Harbor Property Management's statement from Copies Statement Co");
    const text = await messageOf(rows[1]!.message_id);
    expect(text!.body).toMatch(/^It's Copies Statement Co\. A copy of Harbor Property Management's statement for /);

    const audited = await raw<{ action: string; after: { to: string; channel: string; state: string; deliveryId: string } }[]>`
      select action, after from public.audit_log
       where organization_id = ${ORG} and entity_id = ${manager} and action = 'statement.copied_to_typed_address'
         and after ->> 'deliveryId' = ${sent.deliveryId} order by created_at, id`;
    expect(audited.map((a) => [a.after.channel, a.after.to, a.after.state]).sort()).toEqual([
      ["email", "boss@harbor-owners.test", "queued"], ["sms", "(512) 555-0199", "queued"],
    ]);
    // The line for the send says it too.
    const [line] = await raw<{ after: { copies: { typed: boolean; to: string }[] } }[]>`
      select after from public.audit_log where entity_id = ${manager} and action = 'statement.sent'
         and after ->> 'deliveryId' = ${sent.deliveryId}`;
    expect(line!.after.copies.map((c) => [c.typed, c.to])).toEqual([[true, "boss@harbor-owners.test"], [true, "(512) 555-0199"]]);
  });

  it("is held to the rules of its channel: a typed number that replied STOP is not texted", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, '+15125550188', 'sms', 'stop')`;
    try {
      const sent = await statementDelivery.emailStatement(owner(), { id: manager, copies: [{ address: "+15125550188", channel: "sms" }] });
      expect(sent.copies[0]).toMatchObject({ typed: true, state: "refused", explanation: expect.stringMatching(/STOP/) });
      const [audited] = await raw<{ after: { state: string } }[]>`select after from public.audit_log
        where entity_id = ${manager} and action = 'statement.copied_to_typed_address' and after ->> 'deliveryId' = ${sent.deliveryId}`;
      expect(audited!.after.state).toBe("refused");
    } finally {
      await raw`delete from public.suppression where organization_id = ${ORG}`;
    }
  });

  it("is refused in words when what was typed is not an address or a number", async () => {
    await expect(statementDelivery.textStatement(owner(), { id: manager, copies: [{ address: "someone@x.test", channel: "sms" }] }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

run("a typed address needs the right to give customers links", () => {
  /** May send statements and text and email people, but not hand out links to an account. */
  const sender = () => as([], ["invoice:read", "invoice:send", "customer:read"]);
  const both = () => as([], ["invoice:read", "invoice:send", "customer:read", "portal:grant"]);

  it("refuses a typed copy, in words and before anything is recorded or sent, when the sender lacks portal:grant", async () => {
    const before = await deliveryCount(manager);
    const messages = (await raw`select 1 from public.message where organization_id = ${ORG}`).length;
    for (const copies of [
      [{ address: "boss@harbor-owners.test", channel: "email" as const }],
      [{ address: "(512) 555-0199", channel: "sms" as const }],
      // Mixed with one of the customer's own people: the typed one still stops the whole send.
      [{ contactId: clerk, channel: "email" as const }, { address: "boss@harbor-owners.test", channel: "email" as const }],
    ]) {
      await expect(statementDelivery.emailStatement(sender(), { id: manager, copies }))
        .rejects.toThrow(/needs the right to give customers links \(portal:grant\)/);
      await expect(statementDelivery.textStatement(sender(), { id: manager, copies }))
        .rejects.toBeInstanceOf(ConflictError);
    }
    expect(await deliveryCount(manager)).toBe(before);
    expect((await raw`select 1 from public.message where organization_id = ${ORG}`).length).toBe(messages);
  });

  it("still lets the same sender copy the customer's own people on invoice:send alone", async () => {
    const sent = await statementDelivery.emailStatement(sender(), {
      id: manager, copies: [{ contactId: ownerPerson, channel: "email" }, { contactId: clerk, channel: "sms" }],
    });
    expect(sent.copies.map((c) => [c.typed, c.state])).toEqual([[false, "queued"], [false, "queued"]]);
  });

  it("sends to a typed address for a sender who holds both, and audits it", async () => {
    const sent = await statementDelivery.emailStatement(both(), {
      id: manager, copies: [{ address: "accounts@harbor-owners.test", channel: "email" }],
    });
    expect(sent.copies[0]).toMatchObject({ typed: true, state: "queued", destination: "accounts@harbor-owners.test" });
    expect(await raw`select 1 from public.audit_log where entity_id = ${manager}
      and action = 'statement.copied_to_typed_address' and after ->> 'deliveryId' = ${sent.deliveryId}`).toHaveLength(1);
  });
});

