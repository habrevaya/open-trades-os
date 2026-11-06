import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as expiry from "../src/services/estimate-expiry";
import * as extendedNotice from "../src/services/estimate-extended-notice";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, fixtureId, testDb } from "./helpers";

/**
 * THE GIVEN-LONGER WORDS ON A SCREEN, A TEXT HELD FOR THE MORNING, AND A DRAFT
 * PAST ITS DATE MARKED EXPIRED
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("held-draft:org");
const USER = fixtureId("held-draft:user");
const NUMBER = fixtureId("held-draft:number");
const ZONE = "America/Chicago";
const PHONE = "+15125550288";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db() });
const reader = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [], grants: ["settings:read"] } as Actor, db: db(),
});

let customerId = "";
let propertyId = "";

const today = () => time.dateIn(new Date(), ZONE);
const plus = (days: number) => time.addDays(today(), days);

async function sentEstimate(expiresOn = plus(2)) {
  const written = await estimates.create(owner(), {
    customerId, propertyId, title: "Water heater", expiresOn,
    options: [{
      name: "Replace", isRecommended: true,
      lines: [{ name: "Heater", quantity: "1", unitPrice: "1450.00", unitCost: "700.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
    }],
  } as Parameters<typeof estimates.create>[1]);
  await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 3 } as Parameters<typeof estimates.send>[1]);
  await raw`update public.estimate set sent_at = now() - interval '20 days' where id = ${written.id}`;
  return written.id;
}

const texts = (id: string) => raw<{ body: string | null; to_address: string }[]>`
  select m.body, m.to_address from public.estimate_delivery d join public.message m on m.id = d.message_id
  where d.estimate_id = ${id} and d.channel = 'sms' order by d.created_at`;
const heldRows = (id: string) => raw<{ state: string; reason: string | null; note: string }[]>`
  select state, reason, note from public.estimate_held_text where estimate_id = ${id} order by created_at`;

/** Quiet right now, or quiet only at an hour that is not this one (so "the morning" has come). */
async function setQuiet(nowIsQuiet: boolean) {
  const [clock] = await raw<{ hour: number }[]>`select extract(hour from now() at time zone ${ZONE})::int as hour`;
  const hour = clock!.hour;
  const window = nowIsQuiet
    ? { startHour: hour, endHour: (hour + 1) % 24 }
    : { startHour: (hour + 6) % 24, endHour: (hour + 7) % 24 };
  await raw`update public.organization set settings = coalesce(settings, '{}'::jsonb) || ${raw.json({ quietHours: window } as never)} where id = ${ORG}`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Held Plumbing", slug: "held-draft-plumbing" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "quotes@held.test" } as never)})`;
  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
    values (${NUMBER}, ${ORG}, '+15125550277', 'main', true)`;
  const [c] = await raw`insert into public.customer (organization_id, name, email, phone)
    values (${ORG}, 'Hana Held', 'hana@example.test', ${PHONE}) returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '8 Held Rd', 'Austin', 'TX', '78704') returning id`;
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
  // Quiet only at an hour that is not this one, so a test run after 9pm Central is not inside the default window.
  await setQuiet(false);
  await raw`delete from public.message_template where organization_id = ${ORG}`;
});

run("the given-longer words on a screen", () => {
  it("shows the product's own words until the company writes its own, then those", async () => {
    const before = await extendedNotice.words(reader());
    expect(before.templates.map((t) => [t.code, t.channel, t.isDefault])).toEqual([
      ["estimate_extended.sms", "sms", true], ["estimate_extended.email", "email", true],
    ]);
    expect(before.variables).toContain("estimate.expiresOn");

    const after = await extendedNotice.updateWords(owner(), { templates: [
      { code: "estimate_extended.sms", body: "Good news {{ customer.firstName }}: held to {{ estimate.expiresOn }}." },
      { code: "estimate_extended.email", subject: "Held to {{ estimate.expiresOn }}", body: "Your price is held to {{ estimate.expiresOn }}." },
    ] });
    expect(after.templates.map((t) => t.isDefault)).toEqual([false, false]);
    expect(after.templates[1]).toMatchObject({ subject: "Held to {{ estimate.expiresOn }}", body: "Your price is held to {{ estimate.expiresOn }}." });

    // The send reads what was saved.
    const id = await sentEstimate();
    await expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    expect((await texts(id))[0]!.body).toContain("Good news Hana: held to");
  });

  it("refuses a word the notice does not know, and a caller who may not write", async () => {
    await expect(extendedNotice.updateWords(owner(), { templates: [{ code: "estimate_extended.sms", body: "Held, {{ invoice.total }}." }] }))
      .rejects.toThrow();
    await expect(extendedNotice.updateWords(owner(), { templates: [{ code: "agreement_renewal.ends.sms", body: "Nope." }] }))
      .rejects.toThrow(ConflictError);
    await expect(extendedNotice.updateWords(reader(), { templates: [{ code: "estimate_extended.sms", body: "Nope." }] }))
      .rejects.toThrow(PermissionError);
    await expect(extendedNotice.words({ actor: { userId: USER, organizationId: ORG, roles: [], grants: [] } as Actor, db: db() }))
      .rejects.toThrow(PermissionError);
  });
});

run("a text held for the morning", () => {
  it("keeps the text, sends it once when the hours end, and says so on the estimate", async () => {
    await setQuiet(true);
    const id = await sentEstimate();
    const held = await expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    expect(held.told).toMatchObject({ sent: false, heldForMorning: true, explanation: expect.stringMatching(/will go in the morning/) });
    expect(await texts(id)).toEqual([]);
    expect(await heldRows(id)).toMatchObject([{ state: "waiting" }]);

    // Still the quiet hours: nothing goes, nothing is lost, nothing is recorded as refused.
    expect(await expiry.sendHeldTexts(db(), ORG)).toEqual([]);
    expect(await texts(id)).toEqual([]);
    expect((await expiry.heldTextPass(db())).filter((r) => r.organizationId === ORG).flatMap((r) => r.sent)).toEqual([]);

    await setQuiet(false);
    const sent = await expiry.sendHeldTexts(db(), ORG);
    expect(sent).toEqual([{ estimateId: id, state: "sent", reason: null }]);
    const [text] = await texts(id);
    expect(text).toMatchObject({ to_address: PHONE });
    expect(text!.body).toContain("we are holding your price until");
    expect(await heldRows(id)).toMatchObject([{ state: "sent" }]);

    // Once: another pass, and another worker's, send nothing more.
    expect(await expiry.sendHeldTexts(db(), ORG)).toEqual([]);
    // Read for this company only: a text another company's run left waiting is not this one's.
    expect((await expiry.heldTextPass(db())).filter((r) => r.organizationId === ORG)).toEqual([]);
    expect(await texts(id)).toHaveLength(1);
    expect((await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'estimate.held_text_sent' and entity_id = ${id}`)).toHaveLength(1);
    // Telling nobody changed the follow up: the send was quiet, so the sent date is as it was.
    expect((await raw`select 1 from public.estimate where id = ${id} and sent_at < now() - interval '19 days'`)).toHaveLength(1);
    expect((await expiry.handlers.listEstimateHeldTexts(owner(), { id })).heldTexts).toMatchObject([{ state: "sent" }]);
  });

  it("asks the customer's consent again in the morning, and does not text somebody who replied STOP", async () => {
    await setQuiet(true);
    const id = await sentEstimate();
    await expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    await raw`insert into public.suppression (organization_id, address, channel, reason) values (${ORG}, ${PHONE}, 'sms', 'stop')`;
    await setQuiet(false);
    const done = await expiry.sendHeldTexts(db(), ORG);
    expect(done).toMatchObject([{ estimateId: id, state: "refused", reason: expect.stringMatching(/STOP/) }]);
    expect(await texts(id)).toEqual([]);
    // Refused is final: it is not tried again every minute.
    expect(await expiry.sendHeldTexts(db(), ORG)).toEqual([]);
  });

  it("does not send when the estimate was answered, the date moved again, or it was texted by hand since", async () => {
    await setQuiet(true);
    const answered = await sentEstimate();
    await expiry.extend(owner(), { id: answered, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    await raw`update public.estimate set status = 'declined' where id = ${answered}`;

    const moved = await sentEstimate();
    await expiry.extend(owner(), { id: moved, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    await expiry.extend(owner(), { id: moved, expiresOn: plus(20), reason: "Asked again." });

    const byHand = await sentEstimate();
    await expiry.extend(owner(), { id: byHand, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    await setQuiet(false);
    await estimates.send(owner(), { id: byHand, channel: "sms", expiresInDays: 3 } as Parameters<typeof estimates.send>[1]);

    const done = await expiry.sendHeldTexts(db(), ORG);
    expect(done.map((d) => d.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(done.map((d) => d.reason).join(" ")).toMatch(/answered.*moved again.*texted to the customer again/s);
    expect(await texts(answered)).toEqual([]);
    expect(await texts(moved)).toEqual([]);
    expect(await texts(byHand)).toHaveLength(1);
  });

  it("holds one text per estimate: a newer one replaces an older", async () => {
    await setQuiet(true);
    const id = await sentEstimate();
    await expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked.", tellCustomer: true, tellChannel: "sms" });
    await expiry.extend(owner(), { id, expiresOn: plus(12), reason: "Asked again.", tellCustomer: true, tellChannel: "sms" });
    expect(await heldRows(id)).toMatchObject([{ state: "cancelled", reason: "Replaced by a newer text." }, { state: "waiting" }]);
    // A retry of the same change is the change already made: no third.
    await expiry.extend(owner(), { id, expiresOn: plus(12), reason: "Asked again.", tellCustomer: true, tellChannel: "sms" });
    expect(await heldRows(id)).toHaveLength(2);
    await setQuiet(false);
    expect((await expiry.sendHeldTexts(db(), ORG)).map((d) => d.state)).toEqual(["sent"]);
    expect(await texts(id)).toHaveLength(1);
  });
});

run("a draft past its date", () => {
  const draft = async (expiresOn: string | null) => (await estimates.create(owner(), {
    customerId, propertyId, title: "Never sent", ...(expiresOn ? { expiresOn } : {}),
    options: [{
      name: "Replace", isRecommended: true,
      lines: [{ name: "Heater", quantity: "1", unitPrice: "100.00", unitCost: "40.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
    }],
  } as Parameters<typeof estimates.create>[1])).id as string;

  it("is marked expired by the worker, once, and remembered as never sent", async () => {
    const id = await draft(plus(-3));
    const fresh = await draft(plus(5));
    const none = await draft(null);
    const done = await expiry.expireFor(db(), ORG);
    expect(done.map((d) => d.id)).toContain(id);
    expect(done.map((d) => d.id)).not.toContain(fresh);
    expect(done.map((d) => d.id)).not.toContain(none);
    const [row] = await raw<{ status: string; expired_as_draft_at: Date | null; sent_at: Date | null }[]>`
      select status, expired_as_draft_at, sent_at from public.estimate where id = ${id}`;
    expect(row).toMatchObject({ status: "expired", sent_at: null });
    expect(row!.expired_as_draft_at).not.toBeNull();
    expect((await raw`select status from public.estimate where id in (${fresh}, ${none}) and status = 'draft'`)).toHaveLength(2);
    expect(await expiry.expireFor(db(), ORG)).toEqual([]);
    const [audit] = await raw<{ after: { wasDraft?: boolean } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'estimate.expired' and entity_id = ${id}`;
    expect(audit!.after.wasDraft).toBe(true);
    // The worker's pass finds a company with only a draft past its date.
    const pass = await draft(plus(-1));
    const run = await expiry.expiryPass(db(), { force: true });
    expect(run.find((r) => r.organizationId === ORG)?.expired.map((e) => e.id)).toEqual([pass]);
  });

  it("cannot be given longer, because there is no customer to give it to, but can still be sent", async () => {
    const id = await draft(plus(-3));
    await expiry.expireFor(db(), ORG);
    await expect(expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked." })).rejects.toThrow(/has not been sent/);
    await estimates.send(owner(), { id, channel: "link", expiresInDays: 3 } as Parameters<typeof estimates.send>[1]);
    const [row] = await raw<{ status: string; sent_at: Date | null }[]>`select status, sent_at from public.estimate where id = ${id}`;
    expect(row!.status).toBe("expired");
    expect(row!.sent_at).not.toBeNull();
    // Sent, it has a customer, so it can be given longer like any expired estimate.
    const given = await expiry.extend(owner(), { id, expiresOn: plus(9), reason: "Asked." });
    expect(given.status).toBe("sent");
  });
});
