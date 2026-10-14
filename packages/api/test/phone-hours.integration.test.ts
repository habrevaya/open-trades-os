import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as businessHours from "../src/services/business-hours";
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
  return { twiml: reply.twiml, why: call?.routed_because ?? "" };
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
