import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as expiry from "../src/services/estimate-expiry";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * AN ESTIMATE PAST ITS DATE, MARKED EXPIRED BY THE WORKER
 *
 * `expires_on` was printed under "Good until" and acted on by nothing. The
 * worker now marks an open estimate expired once its date has passed in the
 * COMPANY's calendar, touches nothing that was decided, does it once however
 * often it goes round, and the unsold pipeline reads the date itself so it is
 * right between passes.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("expiry:org");
const OTHER = fixtureId("expiry:other");
const USER = fixtureId("expiry:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Expiry Co", slug: "expiry-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [c] = await raw`insert into public.customer (organization_id, name, email)
    values (${ORG}, 'Ines Quill', 'ines@example.test') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '5 Quill Way', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.estimate where organization_id in (${ORG}, ${OTHER})`;
});

/** An estimate in a given state, with a date, written through the service and then set to where the test needs it. */
async function estimate(status: string, expiresOn: string | null, title = status): Promise<string> {
  const written = await estimates.create(owner(), {
    customerId, propertyId, title,
    ...(expiresOn ? { expiresOn } : {}),
    options: [{
      name: "Repair", isRecommended: true,
      lines: [{ name: "Part", quantity: "1", unitPrice: "100.00", unitCost: "40.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
    }],
  } as Parameters<typeof estimates.create>[1]);
  await raw`update public.estimate set status = ${status}::estimate_status,
    sent_at = case when ${status} in ('sent', 'viewed') then now() - interval '5 days' else null end
    where id = ${written.id}`;
  return written.id;
}

const statusOf = async (id: string) => (await raw<{ status: string }[]>`select status from public.estimate where id = ${id}`)[0]!.status;

// 12:00 Chicago on 31 October 2026, a day after the 30th, in daylight time (UTC-5).
const AFTER = new Date("2026-10-31T17:00:00Z");

run("marking an estimate expired", () => {
  it("marks a sent and a viewed estimate once its date has passed in the company's calendar", async () => {
    const sent = await estimate("sent", "2026-10-30");
    const viewed = await estimate("viewed", "2026-10-30");
    const done = await expiry.expireFor(db(), ORG, AFTER);
    expect(done.map((d) => d.id).sort()).toEqual([sent, viewed].sort());
    expect(await statusOf(sent)).toBe("expired");
    expect(await statusOf(viewed)).toBe("expired");
  });

  it("uses the company's day and not UTC's: the date itself is still good all evening", async () => {
    const id = await estimate("sent", "2026-10-30");
    // 22:00 on the 30th in Chicago is 03:00 on the 31st in UTC, which would have read as past the date.
    expect(await expiry.expireFor(db(), ORG, new Date("2026-10-31T03:00:00Z"))).toEqual([]);
    expect(await statusOf(id)).toBe("sent");
    // The last minute of the 30th is still the 30th.
    expect(await expiry.expireFor(db(), ORG, new Date("2026-10-31T04:59:00Z"))).toEqual([]);
    // Midnight on the 31st in Chicago is 05:00Z, and the day has passed.
    expect((await expiry.expireFor(db(), ORG, new Date("2026-10-31T05:00:00Z"))).map((d) => d.id)).toEqual([id]);
    expect(await statusOf(id)).toBe("expired");
  });

  it("does not touch an estimate that is accepted, declined or converted, or a draft", async () => {
    const kept = {
      approved: await estimate("approved", "2026-01-01"),
      declined: await estimate("declined", "2026-01-01"),
      converted: await estimate("converted", "2026-01-01"),
      draft: await estimate("draft", "2026-01-01"),
    };
    const before = await raw<{ id: string; updated_at: Date }[]>`
      select id, updated_at from public.estimate where id in ${raw(Object.values(kept))}`;
    expect(await expiry.expireFor(db(), ORG, AFTER)).toEqual([]);
    for (const [status, id] of Object.entries(kept)) expect(await statusOf(id)).toBe(status);
    const after = await raw<{ id: string; updated_at: Date }[]>`
      select id, updated_at from public.estimate where id in ${raw(Object.values(kept))}`;
    expect(after.map((r) => r.updated_at.getTime()).sort()).toEqual(before.map((r) => r.updated_at.getTime()).sort());
  });

  it("leaves an estimate with no date, or a date still ahead, alone", async () => {
    const none = await estimate("sent", null);
    const ahead = await estimate("viewed", "2026-11-15");
    expect(await expiry.expireFor(db(), ORG, AFTER)).toEqual([]);
    expect(await statusOf(none)).toBe("sent");
    expect(await statusOf(ahead)).toBe("viewed");
  });

  it("is idempotent: a second pass marks nothing and writes no second audit line", async () => {
    const id = await estimate("sent", "2026-10-30");
    expect(await expiry.expireFor(db(), ORG, AFTER)).toHaveLength(1);
    expect(await expiry.expireFor(db(), ORG, AFTER)).toEqual([]);
    expect(await expiry.expireFor(db(), ORG, new Date("2027-03-01T12:00:00Z"))).toEqual([]);
    const audits = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'estimate.expired' and entity_id = ${id}`;
    expect(audits[0]!.n).toBe(1);
    // Two workers at once mark it once between them.
    const again = await estimate("sent", "2026-10-30");
    const both = await Promise.all([expiry.expireFor(db(), ORG, AFTER), expiry.expireFor(db(), ORG, AFTER)]);
    expect(both.flat().map((d) => d.id)).toEqual([again]);
  });

  it("goes round the companies that hold an open estimate with a date, and skips a suspended one", async () => {
    const mine = await estimate("sent", "2026-10-30");
    await seedOrg(raw, { organizationId: OTHER, userId: fixtureId("expiry:user2"), name: "Other Co", slug: "other-expiry-co" });
    await raw`update public.organization set suspended_at = now() where id = ${OTHER}`;
    const [c] = await raw`insert into public.customer (organization_id, name) values (${OTHER}, 'Somebody') returning id`;
    const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${OTHER}, '1 Other St', 'Austin', 'TX', '78701') returning id`;
    const [theirs] = await raw`insert into public.estimate (organization_id, number, customer_id, property_id, status, expires_on, sent_at)
      values (${OTHER}, 1, ${c!.id}, ${p!.id}, 'sent', '2026-10-01', now()) returning id`;

    const results = await expiry.expiryPass(db(), { now: AFTER, force: true });
    const ours = results.find((r) => r.organizationId === ORG);
    expect(ours?.expired.map((e) => e.id)).toEqual([mine]);
    expect(results.some((r) => r.organizationId === OTHER)).toBe(false);
    expect(await statusOf(theirs!.id)).toBe("sent");
    expect((await expiry.expiryPass(db(), { now: AFTER, force: true })).filter((r) => r.organizationId === ORG)).toEqual([]);
  });
});

run("what reads the date", () => {
  it("leaves an estimate past its date out of the unsold pipeline even before the worker has marked it", async () => {
    const old = await estimate("sent", "2020-01-01", "Long gone");
    const today = await estimate("viewed", new Date().toISOString().slice(0, 10), "Good today");
    const open = await estimate("sent", null, "No date");
    const listed = (await estimates.unsold(owner())).map((e) => e.id);
    expect(listed).toContain(open);
    expect(listed).not.toContain(old);
    // Good through its own date, in the company's calendar. Tonight's date in Chicago is never before it.
    const chicagoToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    await raw`update public.estimate set expires_on = ${chicagoToday} where id = ${today}`;
    expect((await estimates.unsold(owner())).map((e) => e.id)).toContain(today);
  });

  it("is left out once marked, and an expired one can still be approved", async () => {
    const id = await estimate("sent", "2026-10-30");
    await expiry.expireFor(db(), ORG, AFTER);
    expect((await estimates.unsold(owner())).map((e) => e.id)).not.toContain(id);
    const [option] = await raw<{ id: string }[]>`select id from public.estimate_option where estimate_id = ${id} limit 1`;
    const approved = await estimates.approve(owner(), {
      id, optionId: option!.id, selectedLineIds: [], signerName: "Ines Quill", capturedVia: "phone",
    } as Parameters<typeof estimates.approve>[1]);
    expect(approved.status).toBe("approved");
  });

  it("sends an estimate that is already past its date as expired, so it never reads as open", async () => {
    const id = await estimate("draft", "2020-01-01");
    const sent = await estimates.send(owner(), { id, channel: "link", expiresInDays: 30 });
    expect(sent.estimate.status).toBe("expired");
    expect((await estimates.unsold(owner())).map((e) => e.id)).not.toContain(id);

    // One with a date still ahead goes out as sent, as it always did.
    const ahead = await estimate("draft", "2099-01-01");
    expect((await estimates.send(owner(), { id: ahead, channel: "link", expiresInDays: 30 })).estimate.status).toBe("sent");
  });
});
