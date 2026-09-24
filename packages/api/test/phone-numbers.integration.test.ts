import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as phoneNumbers from "../src/services/phone-numbers";
import { sendability } from "../src/services/comms-send";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE NUMBERS A COMPANY CONTROLS
 *
 * Two columns on `phone_number` were read everywhere and written nowhere.
 *
 * `attribution_source` is what makes a number a tracking number: marketing
 * maps an inbound call's destination to a lead source through it. Nothing
 * could set it, so the map was always empty and every call resolved to
 * unknown. A company running four tracking numbers got a report saying every
 * call came from nowhere.
 *
 * `released_at` is the other half. Every send filters on it and nothing could
 * set it, so a number handed back to the carrier stayed one this product
 * would send from. The carrier reassigns it within weeks.
 *
 * And making tracking numbers possible exposed a third thing. Sending picked
 * whichever number was created last, which was harmless only while tracking
 * numbers could not exist.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pn:org");
const USER = fixtureId("pn:user");
const MAIN = "+15125559001";
const TRACKING = "+15125559002";
const SECOND_MAIN = "+15125559003";
const THEIRS = "+15125550501";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Number Co", slug: "number-co" });
  await raw`insert into public.communication_consent
    (organization_id, address, channel, purpose, state, method, captured_at)
    values (${ORG}, ${THEIRS}, 'sms', 'transactional', 'granted', 'verbal', now())`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.call where organization_id = ${ORG}`;
  await raw`delete from public.phone_number where organization_id = ${ORG}`;
});

run("tagging a tracking number", () => {
  it("records the source a call to it attributes to", async () => {
    const row = await phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", label: "Spring mailer",
      attributionSource: "direct_mail", smsRegistered: false,
    });
    expect(row.attributionSource).toBe("direct_mail");
  });

  it("refuses a source this product does not report on", async () => {
    /**
     * The marketing module already ignores a value it does not recognise, so
     * a typo could not corrupt a report. What it could do is nothing at all:
     * the field saves, the screen shows it, and the number silently is not a
     * tracking number.
     */
    await expect(phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", attributionSource: "spring mailer",
    })).rejects.toThrow(/not a lead source/i);
  });

  it("refuses a tracking number with nothing to attribute to", async () => {
    await expect(phoneNumbers.add(owner(), { e164: TRACKING, purpose: "tracking" }))
      .rejects.toThrow(/measures nothing/i);
  });

  it("refuses a source on a number that is not a tracking number", async () => {
    /**
     * A source on the main number reads as attribution and is not: the map
     * is only consulted for the number a call arrived on, and every call to
     * the main number is the main number.
     */
    await expect(phoneNumbers.add(owner(), {
      e164: MAIN, purpose: "main", attributionSource: "direct_mail",
    })).rejects.toThrow(/Only a tracking number/i);
  });

  it("refuses clearing the source on a tracking number", async () => {
    const row = await phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", attributionSource: "direct_mail",
    });
    await expect(phoneNumbers.update(owner(), { id: row.id, attributionSource: null }))
      .rejects.toThrow(/measures nothing/i);
  });

  it("refuses something that is not an E.164 number", async () => {
    await expect(phoneNumbers.add(owner(), { e164: "(512) 555-9001" }))
      .rejects.toThrow(/E\.164/);
  });

  it("refuses the same number twice", async () => {
    await phoneNumbers.add(owner(), { e164: MAIN });
    await expect(phoneNumbers.add(owner(), { e164: MAIN }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a role without settings:write", async () => {
    await expect(phoneNumbers.add(as(["technician"]), { e164: MAIN }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("which number a text comes from", () => {
  it("does not send from a tracking number", async () => {
    await phoneNumbers.add(owner(), { e164: MAIN, purpose: "main", smsRegistered: true });
    await phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", attributionSource: "direct_mail",
      smsRegistered: true,
    });

    /**
     * The tracking number is newer and registered, so the old rule picked
     * it. A text from a tracking number is worse than no text: the customer
     * replies, the reply lands on the campaign number, and the campaign is
     * credited with a lead that is a reply to our own text.
     */
    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision.from?.e164).toBe(MAIN);
  });

  it("does not change what customers see when a second main number is bought", async () => {
    await phoneNumbers.add(owner(), { e164: MAIN, purpose: "main", smsRegistered: true });
    await phoneNumbers.add(owner(), { e164: SECOND_MAIN, purpose: "main", smsRegistered: true });

    /**
     * Oldest first within a purpose. A company's main number is the one they
     * have had for eleven years, and buying a second should not silently
     * change what every customer sees a text from.
     */
    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision.from?.e164).toBe(MAIN);
  });

  it("refuses to send when only a tracking number is registered", async () => {
    await phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", attributionSource: "direct_mail",
      smsRegistered: true,
    });

    /**
     * Absent rather than ranked last. Ranking it last still picks it when it
     * is all there is, which is exactly the case this refuses.
     */
    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision).toMatchObject({ allowed: false, reason: "channel_not_registered" });
  });

  it("prefers a sending pool number over somebody's own line", async () => {
    await phoneNumbers.add(owner(), { e164: SECOND_MAIN, purpose: "user", smsRegistered: true });
    await phoneNumbers.add(owner(), { e164: MAIN, purpose: "sending", smsRegistered: true });

    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision.from?.e164).toBe(MAIN);
  });

  it("marks the sender on the list, so nobody has to work it out", async () => {
    await phoneNumbers.add(owner(), { e164: MAIN, purpose: "main", smsRegistered: true });
    await phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", attributionSource: "direct_mail", smsRegistered: true,
    });

    const rows = await phoneNumbers.list(owner(), {});
    expect(rows.filter((r) => r.isSender).map((r) => r.e164)).toEqual([MAIN]);
  });
});

run("handing a number back", () => {
  it("stops it being sent from without deleting its history", async () => {
    const main = await phoneNumbers.add(owner(), { e164: MAIN, purpose: "main", smsRegistered: true });
    await phoneNumbers.add(owner(), { e164: SECOND_MAIN, purpose: "main", smsRegistered: true });

    const result = await phoneNumbers.release(owner(), { id: main.id, reason: "Ported away." });
    expect(result.nowSendingFrom).toBe(SECOND_MAIN);

    /**
     * Stamped rather than deleted, which the schema comment has always said
     * and nothing could do. A released number is reassigned within weeks and
     * a call from 2023 still has to say which campaign it arrived on;
     * deleting the row would re-attribute years of history to whoever holds
     * it next.
     */
    const [row] = await raw<{ released_at: Date | null }[]>`
      select released_at from public.phone_number where id = ${main.id}`;
    expect(row!.released_at).not.toBeNull();

    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision.from?.e164).toBe(SECOND_MAIN);
  });

  it("allows releasing the last one and says what that means", async () => {
    const only = await phoneNumbers.add(owner(), { e164: MAIN, purpose: "main", smsRegistered: true });

    /**
     * A company leaving a provider releases everything, and a product that
     * refuses the last one makes them edit the database. What it must not do
     * is let it happen silently: from here every text is refused, and
     * finding that out from a customer is worse than being told now.
     */
    const result = await phoneNumbers.release(owner(), { id: only.id });
    expect(result.nowSendingFrom).toBeNull();

    expect(await sendability(db(), ORG, THEIRS))
      .toMatchObject({ allowed: false, reason: "channel_not_registered" });
  });

  it("refuses to release the same number twice", async () => {
    const main = await phoneNumbers.add(owner(), { e164: MAIN });
    await phoneNumbers.release(owner(), { id: main.id });
    await expect(phoneNumbers.release(owner(), { id: main.id }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("hides it from the list unless asked for", async () => {
    const main = await phoneNumbers.add(owner(), { e164: MAIN });
    await phoneNumbers.release(owner(), { id: main.id });

    expect((await phoneNumbers.list(owner(), {})).map((r) => r.e164)).toEqual([]);
    expect((await phoneNumbers.list(owner(), { includeReleased: true })).map((r) => r.e164))
      .toEqual([MAIN]);
  });

  it("refuses a number that is not ours", async () => {
    await expect(phoneNumbers.release(owner(), { id: fixtureId("pn:missing") }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

run("whether a tracking number is doing anything", () => {
  it("counts the calls it has actually brought in", async () => {
    const tracking = await phoneNumbers.add(owner(), {
      e164: TRACKING, purpose: "tracking", label: "Spring mailer",
      attributionSource: "direct_mail",
    });
    const dead = await phoneNumbers.add(owner(), {
      e164: SECOND_MAIN, purpose: "tracking", label: "Yard signs",
      attributionSource: "yard_sign",
    });

    await raw`insert into public.call
      (organization_id, phone_number_id, direction, from_e164, to_e164, status)
      values (${ORG}, ${tracking.id}, 'inbound', ${THEIRS}, ${TRACKING}, 'completed')`;

    const usage = await phoneNumbers.trackingUsage(owner(), {});
    const byId = new Map(usage.map((u) => [u.id, u.calls]));
    /**
     * A tracking number that has taken no calls in three months is either a
     * campaign that is not running or a forward that is broken, and the two
     * look identical from a report that only shows sources with calls on
     * them. Zero is shown rather than omitted.
     */
    expect(byId.get(tracking.id)).toBe(1);
    expect(byId.get(dead.id)).toBe(0);
  });
});
