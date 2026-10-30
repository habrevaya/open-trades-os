import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as expiry from "../src/services/estimate-expiry";
import * as portal from "../src/services/portal";
import * as templates from "../src/services/message-templates";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, fixtureId, testDb } from "./helpers";

/**
 * TELLING THE CUSTOMER THEY WERE GIVEN LONGER (M07)
 *
 * "Tell the customer" is off unless asked for. Asked for, it is the
 * estimate's own send with the company's words naming the new date, held to
 * consent, the STOP list and the company's quiet hours for a text, and a
 * customer who cannot be told does not undo the date.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("extended-notice:org");
const USER = fixtureId("extended-notice:user");
const NUMBER = fixtureId("extended-notice:number");
const ZONE = "America/Chicago";
const OUR_NUMBER = "+15125550177";
const PHONE = "+15125550188";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db() });
const writerOnly = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [], grants: ["estimate:read", "estimate:write"] } as Actor, db: db(),
});

let customerId = "";
let noEmailId = "";
let noPhoneId = "";
let propertyId = "";

const today = () => time.dateIn(new Date(), ZONE);
const plus = (days: number) => time.addDays(today(), days);

async function sentEstimate(forCustomer = customerId, expiresOn = plus(2)) {
  const written = await estimates.create(owner(), {
    customerId: forCustomer, propertyId, title: "Water heater", expiresOn,
    options: [{
      name: "Replace", isRecommended: true,
      lines: [{ name: "Heater", quantity: "1", unitPrice: "1450.00", unitCost: "700.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
    }],
  } as Parameters<typeof estimates.create>[1]);
  const sent = await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 3 } as Parameters<typeof estimates.send>[1]);
  await raw`update public.estimate set sent_at = now() - interval '20 days' where id = ${written.id}`;
  return { id: written.id, token: sent.approvalUrl!.split("/e/")[1]! };
}

const messages = (id: string) => raw<{
  channel: string; to_address: string; subject: string | null; body: string | null; purpose: string;
}[]>`select m.channel, m.to_address, m.subject, m.body, m.purpose from public.estimate_delivery d
     join public.message m on m.id = d.message_id where d.estimate_id = ${id} order by d.created_at`;
const sentEvents = async (id: string) => (await raw`select 1 from public.domain_event
  where name = 'estimate.sent' and entity_id = ${id}`).length;
const sentAt = async (id: string) => (await raw<{ s: Date }[]>`select sent_at as s from public.estimate where id = ${id}`)[0]!.s;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Notice Plumbing", slug: "extended-notice-plumbing" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "quotes@notice.test" } as never)})`;
  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
    values (${NUMBER}, ${ORG}, ${OUR_NUMBER}, 'main', true)`;
  const make = async (name: string, email: string | null, phone: string | null) => {
    const [c] = await raw`insert into public.customer (organization_id, name, email, phone)
      values (${ORG}, ${name}, ${email}, ${phone}) returning id`;
    return c!.id as string;
  };
  customerId = await make("Rosa Notice", "rosa@example.test", PHONE);
  noEmailId = await make("Tom Textonly", null, "+15125550199");
  noPhoneId = await make("Ellen Emailonly", "ellen@example.test", null);
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Notice Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'quietHours' where id = ${ORG}`;
});

run("telling the customer", () => {
  it("tells nobody unless asked, and says so in the answer", async () => {
    const { id } = await sentEstimate();
    const given = await expiry.extend(owner(), { id, expiresOn: plus(14), reason: "Insurer is slow." });
    expect(given.told).toBeNull();
    expect(await messages(id)).toEqual([]);
  });

  it("emails them the new date above a link that works through it, and withdraws the old link", async () => {
    const { id, token } = await sentEstimate();
    const before = await sentAt(id);
    const given = await expiry.extend(owner(), {
      id, expiresOn: plus(14), reason: "Insurer is slow.", tellCustomer: true, restartFollowUp: true,
    });
    expect(given.told).toEqual({ sent: true, channels: ["email"], explanation: null });
    expect(given.linkExpiresAt && new Date(given.linkExpiresAt) >= time.daysFrom(plus(14), 1, ZONE).end).toBe(true);

    const [mail] = await messages(id);
    expect(mail).toMatchObject({ channel: "email", to_address: "rosa@example.test", purpose: "transactional" });
    const longDate = new Date(`${plus(14)}T12:00:00Z`)
      .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    expect(mail!.subject).toBe(`Your estimate is held until ${longDate}`);
    expect(mail!.body).toContain(`We are holding the price on your estimate until ${longDate}.`);
    expect(mail!.body).toMatch(/\/e\//);

    // One live link: the one in the message. The one handed over by hand before it is withdrawn.
    await expect(portal.viewEstimate(db(), { token })).rejects.toThrow();
    const link = (mail!.body ?? "").match(/\/e\/([A-Za-z0-9_-]+)/)![1]!;
    await expect(portal.viewEstimate(db(), { token: link })).resolves.toBeDefined();

    // Sending is what starts the follow up, so the send's own event stands and a second is not started.
    expect(await sentEvents(id)).toBe(2);
    expect((await sentAt(id)).getTime()).toBeGreaterThan(before.getTime());
    const [audited] = await raw<{ after: Record<string, unknown> }[]>`select after from public.audit_log
      where entity_id = ${id} and action = 'estimate.expiry_extended'`;
    expect(audited!.after).toMatchObject({ customerTold: true, toldBy: ["email"], followUpRestarted: true, followUpRuns: 0 });
  });

  it("tells them without starting the follow up when the office left it alone", async () => {
    const { id } = await sentEstimate();
    const before = await sentAt(id);
    const events = await sentEvents(id);
    const given = await expiry.extend(owner(), { id, expiresOn: plus(14), reason: "Asked.", tellCustomer: true });
    expect(given.told?.sent).toBe(true);
    expect((await sentAt(id)).getTime()).toBe(before.getTime());
    expect(await sentEvents(id)).toBe(events);
  });

  it("texts them in the company's words when asked to, and by both", async () => {
    await templates.define(owner(), {
      code: "estimate_extended.sms", name: "Held (text)", channel: "sms",
      body: "Your price is safe until {{ estimate.expiresOn }}, {{ customer.firstName }}.",
    });
    try {
      const text = await sentEstimate();
      const asText = await expiry.extend(owner(), { id: text.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
      expect(asText.told).toEqual({ sent: true, channels: ["sms"], explanation: null });
      const [sms] = await messages(text.id);
      expect(sms).toMatchObject({ channel: "sms", to_address: PHONE });
      expect(sms!.body).toMatch(/^Hi Rosa, it's Notice Plumbing\. Your price is safe until .+, Rosa\. Your estimate for Water heater is ready/);

      const both = await sentEstimate();
      const asBoth = await expiry.extend(owner(), { id: both.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "both" });
      expect(asBoth.told?.channels.sort()).toEqual(["email", "sms"]);
      // The email is the product's own words, since only the text has company words.
      expect((await messages(both.id)).find((m) => m.channel === "email")!.body).toContain("We are holding the price");
    } finally {
      await raw`delete from public.message_template where organization_id = ${ORG}`;
    }
  });

  it("does not text them when they replied STOP, and the date still moves", async () => {
    const { id } = await sentEstimate();
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${PHONE}, 'sms', 'stop')`;
    const given = await expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    expect(given.expiresOn).toBe(plus(9));
    expect(given.told).toMatchObject({ sent: false, channels: [], explanation: expect.stringMatching(/STOP/) });
    expect(await raw`select 1 from public.estimate where id = ${id} and expires_on = ${plus(9)}`).toHaveLength(1);
  });

  it("holds a text in the company's quiet hours, but not the email beside it", async () => {
    const [{ hour }] = await raw<{ hour: number }[]>`select extract(hour from now() at time zone ${ZONE})::int as hour`;
    // A window that covers this hour and no other.
    await raw`update public.organization set settings = coalesce(settings, '{}'::jsonb)
      || ${raw.json({ quietHours: { startHour: hour, endHour: (hour + 1) % 24 } } as never)} where id = ${ORG}`;
    const text = await sentEstimate();
    const held = await expiry.extend(owner(), { id: text.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    expect(held.told).toMatchObject({ sent: false, explanation: expect.stringMatching(/outside the hours we text people/) });
    expect(await messages(text.id)).toEqual([]);

    const both = await sentEstimate();
    const half = await expiry.extend(owner(), { id: both.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "both" });
    expect(half.told).toMatchObject({ sent: true, channels: ["email"], explanation: expect.stringMatching(/The text did not go/) });
  });

  it("says what is missing when the customer has no address for the channel", async () => {
    const noMail = await sentEstimate(noEmailId);
    const a = await expiry.extend(owner(), { id: noMail.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "email" });
    expect(a.told).toMatchObject({ sent: false, explanation: expect.stringMatching(/no an email address|no email address/) });
    // With no channel named, a customer with no email is texted.
    const byDefault = await sentEstimate(noEmailId);
    expect((await expiry.extend(owner(), { id: byDefault.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true })).told)
      .toMatchObject({ sent: true, channels: ["sms"] });

    const noText = await sentEstimate(noPhoneId);
    const b = await expiry.extend(owner(), { id: noText.id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "both" });
    expect(b.told).toMatchObject({ sent: false, channels: [], explanation: expect.stringMatching(/mobile number/) });
    expect(await messages(noText.id)).toEqual([]);
  });

  it("tells nobody twice when the same change is sent again", async () => {
    const { id } = await sentEstimate();
    const input = { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true } as const;
    await expiry.extend(owner(), input);
    const again = await expiry.extend(owner(), input);
    expect(again.told).toBeNull();
    expect(await messages(id)).toHaveLength(1);
  });

  it("needs the right to send as well as to write estimates, and changes nothing without it", async () => {
    const { id } = await sentEstimate();
    await expect(expiry.extend(writerOnly(), { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true }))
      .rejects.toThrow(PermissionError);
    expect(await raw`select 1 from public.estimate where id = ${id} and expires_on = ${plus(2)}`).toHaveLength(1);
    // Moving the date alone is still estimate:write's.
    await expect(expiry.extend(writerOnly(), { id, expiresOn: plus(9), reason: "Asked." })).resolves.toMatchObject({ told: null });
  });
});
