import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as businessHours from "../src/services/business-hours";
import * as numberHours from "../src/services/number-hours";
import * as holidays from "../src/services/holidays";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M18. A NUMBER ROUTED BY THE HOURS OF THE PLACE IT BELONGS TO
 *
 * Phone Hours Co is shut at the weekend; its Houston branch opens Saturday
 * mornings. A number that belongs to Houston and routes by hours rings the
 * office on a Saturday morning, and the company's own number sends the same
 * call to the after hours line. Calls arrive through the carrier's signed
 * webhook, as in `native-calls`; nothing reaches Twilio.
 *
 * Then the Houston line is given hours of its own, open around the clock,
 * and days off of its own: the company's day off no longer shuts it, its
 * own does, and it can be put back on the company's hours or its branch's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("phone-hours:org");
const USER = fixtureId("phone-hours:user");
const SLUG = "phone-hours-co";
const AUTH = "a-twilio-auth-token-for-phone-hours";
const TOKEN = "h".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125556000";
const HOUSTON_LINE = "+17135556000";
const OFFICE = "+15125556001";
const AFTER = "+15125556002";
/** Saturday 9 January 2027, nine in the morning in Chicago. */
const SATURDAY_MORNING = new Date("2027-01-09T15:00:00Z");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

const transport = async (): Promise<Response> => Response.json({ message: "unexpected" }, { status: 400 });
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const deps: voice.VoiceDeps = { readSecret: async () => AUTH, provider, publicBase: BASE };

function signed(form: Record<string, string>) {
  const to = `${BASE}/api/webhooks/voice/${TOKEN}`;
  return { url: to, body: new URLSearchParams(form).toString(), headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) } };
}

/** A call to a number at a moment, and where it was sent and why. */
async function ring(to: string, now: Date): Promise<{ twiml: string; why: string }> {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const reply = await voice.handle(db(), connection, "incoming", signed({ CallSid: sid, From: "+15125550199", To: to }), deps, now);
  const [call] = await raw<{ routed_because: string }[]>`select routed_because from public.call where provider_call_id = ${`twilio:${sid}`}`;
  return { twiml: reply.twiml ?? "", why: call?.routed_because ?? "" };
}

let houston = "";
let houstonLine = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Phone Hours Co", slug: SLUG });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  houston = h!.id;
  const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
  }));
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "17:00") });
  await businessHours.setWeek(owner(), { days: week([2, 3, 4, 5, 6], "07:00", "12:00"), businessUnitId: houston });
  for (const e164 of [MAIN, HOUSTON_LINE]) {
    const [row] = await raw<{ id: string }[]>`insert into public.phone_number (organization_id, e164, purpose, provider_number_id, forwards_to_e164,
        route_by_hours, after_hours_forwards_to_e164)
      values (${ORG}, ${e164}, 'main', ${`PN${e164.slice(-4)}${e164.slice(2, 5)}`}, ${OFFICE}, true, ${AFTER}) returning id`;
    if (e164 === HOUSTON_LINE) houstonLine = row!.id;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

run("a number's hours", () => {
  it("puts a number in a branch, and refuses a retired one", async () => {
    const [gone] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name, active) values (${ORG}, 'Waco', false) returning id`;
    await expect(voice.handlers.setNumberRouting(owner(), { id: houstonLine, businessUnitId: gone!.id })).rejects.toThrow(/retired/);
    const set = await voice.handlers.setNumberRouting(owner(), { id: houstonLine, businessUnitId: houston });
    expect(set.businessUnitId).toBe(houston);
    /** Changing something else leaves the branch where it is. */
    expect((await voice.handlers.setNumberRouting(owner(), { id: houstonLine, whisper: false })).businessUnitId).toBe(houston);
  });

  it("rings the office on a Houston number on Houston's Saturday morning, and sends the company's number after hours", async () => {
    const houstonCall = await ring(HOUSTON_LINE, SATURDAY_MORNING);
    expect(houstonCall.twiml).toContain(`>${OFFICE}</Number>`);
    expect(houstonCall.why).toContain("inside business hours");
    const companyCall = await ring(MAIN, SATURDAY_MORNING);
    expect(companyCall.twiml).toContain(`>${AFTER}</Number>`);
  });
});

run("a number's own hours and days off", () => {
  const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: "00:00", closesAt: "23:59", closed: false }));
  const keyed = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: `${key}-${randomBytes(4).toString("hex")}` });

  it("follows the company's hours when told to, whatever its branch keeps", async () => {
    const set = await numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "company" });
    expect(set.routedBy).toMatchObject({ source: "company", whose: "The company's hours" });
    expect((await ring(HOUSTON_LINE, SATURDAY_MORNING)).twiml).toContain(`>${AFTER}</Number>`);
    const back = await numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "branch" });
    expect(back.routedBy).toMatchObject({ source: "branch", whose: "Houston's hours" });
  });

  it("refuses its own hours until they are said, and somebody who may not change settings", async () => {
    await expect(numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "own" })).rejects.toThrow(/Say this number's own hours/);
    await expect(numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "branch", days: ALWAYS }))
      .rejects.toThrow(/only kept for a number set to keep its own hours/);
    await expect(numberHours.setHours({ ...owner(), actor: { ...owner().actor, roles: ["dispatcher"] } }, { id: houstonLine, hoursFrom: "company" }))
      .rejects.toThrow();
  });

  it("is shut by the company's day off while it follows its branch, and not once it keeps its own", async () => {
    const party = await holidays.create(keyed("party"), { name: "Shop party", date: "2027-01-09", closed: true });
    try {
      expect((await ring(HOUSTON_LINE, SATURDAY_MORNING)).twiml).toContain(`>${AFTER}</Number>`);
      const own = await numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "own", days: ALWAYS });
      expect(own.routedBy).toMatchObject({ source: "number", whose: "Its own hours" });
      expect(own.ownWeek).toHaveLength(7);
      expect((await ring(HOUSTON_LINE, SATURDAY_MORNING)).twiml).toContain(`>${OFFICE}</Number>`);
      /** Three in the morning on a Sunday, which the company and Houston both keep shut. */
      expect((await ring(HOUSTON_LINE, new Date("2027-01-10T09:00:00Z"))).twiml).toContain(`>${OFFICE}</Number>`);
    } finally {
      await holidays.remove(owner(), { id: party.id });
    }
  });

  it("is shut by a day off of its own, which no other list sees, and opened again when it is taken off", async () => {
    const ctx = keyed("own-day");
    const day = await numberHours.addHoliday(ctx, { id: houstonLine, name: "Line maintenance", date: "2027-01-09", closed: true });
    /** The same request again is the same day off, not a second one. */
    expect((await numberHours.addHoliday(ctx, { id: houstonLine, name: "Line maintenance", date: "2027-01-09", closed: true })).id).toBe(day.id);
    await expect(numberHours.addHoliday(keyed("again"), { id: houstonLine, name: "Twice", date: "2027-01-09", closed: true }))
      .rejects.toThrow(/already on the list/);
    expect((await ring(HOUSTON_LINE, SATURDAY_MORNING)).twiml).toContain(`>${AFTER}</Number>`);

    /** The company's list, and every reader of it, never sees the number's own day. */
    const company = await holidays.create(keyed("company-same-day"), { name: "Same day for the company", date: "2027-01-09", closed: true });
    expect((await holidays.list(owner())).map((h) => h.name)).toEqual(["Same day for the company"]);
    await holidays.remove(owner(), { id: company.id });
    expect(await holidays.loadHolidays(db(), ORG, houston)).toEqual([]);
    await expect(holidays.remove(owner(), { id: day.id })).rejects.toThrow(/Holiday/);

    const view = await numberHours.view(owner(), { id: houstonLine });
    expect(view.ownHolidays.map((h) => h.name)).toEqual(["Line maintenance"]);
    expect(await numberHours.removeHoliday(owner(), { id: houstonLine, holidayId: day.id })).toEqual({ removed: true });
    expect(await numberHours.removeHoliday(owner(), { id: houstonLine, holidayId: day.id })).toEqual({ removed: false });
    expect((await ring(HOUSTON_LINE, SATURDAY_MORNING)).twiml).toContain(`>${OFFICE}</Number>`);
  });

  it("keeps its own week when it goes back to its branch, and setting the company's week leaves it alone", async () => {
    await numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "branch" });
    await businessHours.setWeek(owner(), { days: (await businessHours.list(owner())).company });
    const view = await numberHours.view(owner(), { id: houstonLine });
    expect(view.ownWeek).toHaveLength(7);
    expect(view.routedBy.source).toBe("branch");
    expect((await numberHours.setHours(owner(), { id: houstonLine, hoursFrom: "own" })).routedBy.source).toBe("number");
  });
});
