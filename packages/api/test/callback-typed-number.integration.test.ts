import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as callQueues from "../src/services/call-queues";
import * as phoneMenus from "../src/services/phone-menus";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M18. A CALLER WAITING FOR A CALLBACK TYPES ANOTHER NUMBER
 *
 * A caller in a waiting line presses 1 to be called back. Before they hang
 * up they may press 2 and type a different number on the keypad: the digits
 * are checked (ten digits with the area code, never a service code, a
 * premium rate number or the company's own line), read back a digit at a
 * time, and used only once the caller confirms with 1. While they type, the
 * group is not rung for the callback, so nobody rings a number about to
 * change; hanging up mid way keeps the number they called from.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in, and every carrier request is signed as Twilio signs it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("callback-typed:org");
const OWNER = fixtureId("callback-typed:owner");
const SAM = fixtureId("callback-typed:sam");
const AUTH = "a-twilio-auth-token-for-typed-callbacks";
const TOKEN = "t".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125558200";
const SAM_PHONE = "+15125558202";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

const placed: URLSearchParams[] = [];
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  if (to.endsWith("/Calls.json") && init?.method === "POST") {
    placed.push(new URLSearchParams(String(init.body)));
    return Response.json({ sid: `CAleg${randomBytes(4).toString("hex")}` });
  }
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const deps: voice.VoiceDeps = { readSecret: async () => AUTH, provider, publicBase: BASE };

async function webhook(step: voice.Step, form: Record<string, string>, query: string, now: Date) {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}${query}`;
  const replied = await voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  }, deps, now);
  return replied.twiml ?? "";
}

const attribute = (twiml: string, verb: string, name: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${name}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${name} in ${twiml}`);
  return match[1]!.replace(/&amp;/g, "&");
};
const queryOf = (address: string) => address.slice(address.indexOf("?"));
const gatherQuery = (twiml: string) => queryOf(attribute(twiml, "Gather", "action"));

let clock = Date.parse("2026-10-07T15:00:00Z");
const tick = (seconds: number) => new Date((clock += seconds * 1000));
let lineId = "";

/** A caller joins the line, presses 1 during the music, and leaves it: what they hear next. */
async function askForCallback(from: string) {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const at = tick(600);
  const answered = await webhook("incoming", { CallSid: sid, From: from, To: MAIN }, "", at);
  const joined = await webhook("menu", { CallSid: sid, Digits: "1" }, gatherQuery(answered), at);
  const wait = queryOf(attribute(joined, "Enqueue", "waitUrl"));
  const done = queryOf(attribute(joined, "Enqueue", "action"));
  const turn = await webhook("queue-wait", { CallSid: sid, QueuePosition: "1", QueueTime: "0" }, wait, tick(1));
  await webhook("queue-callback", { CallSid: sid, Digits: "1", QueueTime: "10" }, gatherQuery(turn), tick(10));
  const left = await webhook("queue-done", { CallSid: sid, QueueResult: "leave", QueueTime: "11" }, done, tick(1));
  return { sid, left };
}

async function callbackOf(sid: string) {
  const [row] = await raw<{ id: string; callback_e164: string; not_before: Date | null; status: string; call_id: string }[]>`
    select qc.id, qc.callback_e164, qc.not_before, qc.status, qc.call_id from public.queue_callback qc
      join public.call c on c.id = qc.call_id where c.provider_call_id = ${`twilio:${sid}`}`;
  return row!;
}

async function routedOf(sid: string): Promise<string> {
  const [row] = await raw<{ routed_because: string }[]>`select routed_because from public.call where provider_call_id = ${`twilio:${sid}`}`;
  return row?.routed_because ?? "";
}

/** Nobody left waiting from the test before. */
async function clearLine() {
  await raw`update public.call set queue_result = coalesce(queue_result, 'hangup'), status = 'completed', ended_at = coalesce(ended_at, now())
            where organization_id = ${ORG} and (queue_result is null or ended_at is null)`;
  await raw`update public.queue_callback set status = 'done', ended_at = now() where organization_id = ${ORG} and status in ('waiting', 'calling')`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Typed Callback Heating", slug: "callback-typed-co" });
  await raw`delete from public."user" where id = ${SAM}`;
  await raw`insert into public."user" (id, email, name) values (${SAM}, 'sam@callback-typed.test', 'Sam Typed')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${SAM}, 'csr')`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, provider_number_id) values (${ORG}, ${MAIN}, 'main', 'PNtypedmain')`;
  await phoneMenus.setAnsweringPhone(owner(), { userId: SAM, e164: SAM_PHONE });
  const groupId = (await phoneMenus.saveRingGroup(owner(), {
    name: "Service team", strategy: "in_order", ringSeconds: 20,
    members: [{ userId: SAM }], noAnswerTo: { kind: "voicemail", box: "main" },
  })).id;
  lineId = (await callQueues.saveQueue(owner(), {
    name: "Service line", ringGroupId: groupId, maxWaitSeconds: 600, overflowTo: { kind: "voicemail", box: "main" },
    offerCallback: true, announceWait: false,
  })).id;
  const menu = await phoneMenus.saveMenu(owner(), {
    name: "Main", greeting: "Thanks for calling Typed Callback Heating.",
    options: [{ key: "1", label: "Service", to: { kind: "queue", id: lineId } }],
    noInputTo: { kind: "voicemail", box: "main" },
  });
  await raw`update public.phone_number set menu_id = ${menu.id} where organization_id = ${ORG}`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a callback number typed on the keypad", () => {
  it("offers another number once the caller asks, and keeps theirs when they press nothing", async () => {
    await clearLine();
    const { left } = await askForCallback("+15125558271");
    expect(left).toContain(`<Gather action="${BASE}/api/webhooks/voice/${TOKEN}/callback-number?k=`);
    expect(left).toContain("<Say>You keep your place in line. To be called back on a different number, press 2.</Say></Gather>");
    expect(left).toContain("<Say>Thanks. We will call you back on 5 1 2, 5 5 5, 8 2 7 1 when it is your turn, so you can hang up now. Goodbye.</Say><Hangup/>");
  });

  it("takes the digits, reads them back, and rings the typed number once the caller confirms", async () => {
    await clearLine();
    const { sid, left } = await askForCallback("+15125558272");
    const before = await callbackOf(sid);
    const asked = await webhook("callback-number", { CallSid: sid, Digits: "2" }, gatherQuery(left), tick(2));
    expect(asked).toContain('numDigits="11" timeout="8" finishOnKey="#"');
    expect(asked).toContain("<Say>Type the number to call you back on, with its area code, then press pound.</Say>");
    const held = await callbackOf(sid);
    expect(held.not_before!.getTime()).toBe(clock + 3 * 60 * 1000);

    /** Somebody picking up for the line while the caller types is not handed the callback. */
    const picked = await webhook("queue-answer", { CallSid: "CAsamtyped1", To: SAM_PHONE }, `?q=${lineId}`, tick(1));
    expect(picked).toContain("The caller has already been answered.");
    expect(picked).not.toContain("+15125558272");

    const typed = await webhook("callback-typed", { CallSid: sid, Digits: "5125550147" }, gatherQuery(asked), tick(8));
    expect(typed).toContain("<Say>You typed 5 1 2, 5 5 5, 0 1 4 7. To be called back on that number, press 1. To type it again, press 2.</Say>");
    const confirmed = await webhook("callback-confirm", { CallSid: sid, Digits: "1" }, gatherQuery(typed), tick(3));
    expect(confirmed).toContain("<Say>Thanks. We will call you back on 5 1 2, 5 5 5, 0 1 4 7 when it is your turn, so you can hang up now. Goodbye.</Say><Hangup/>");

    const after = await callbackOf(sid);
    expect(after).toMatchObject({ id: before.id, callback_e164: "+15125550147", not_before: null, status: "waiting" });
    expect(await routedOf(sid)).toContain("Typed another number to be called back on: +15125550147, instead of +15125558272.");
    const [audit] = await raw<{ before: { number: string }; after: { number: string } }[]>`
      select before, after from public.audit_log where organization_id = ${ORG} and action = 'call.callback_number_changed' and entity_id = ${after.call_id}`;
    expect(audit).toMatchObject({ before: { number: "+15125558272" }, after: { number: "+15125550147" } });

    /** The person next free rings the number the caller typed. */
    const rung = await webhook("queue-answer", { CallSid: "CAsamtyped2", To: SAM_PHONE }, `?q=${lineId}`, tick(5));
    expect(rung).toContain("<Number>+15125550147</Number>");
  });

  it("asks again for a number it cannot call, and after the third keeps the number they called from", async () => {
    await clearLine();
    const { sid, left } = await askForCallback("+15125558273");
    const asked = await webhook("callback-number", { CallSid: sid, Digits: "2" }, gatherQuery(left), tick(2));
    const short = await webhook("callback-typed", { CallSid: sid, Digits: "911" }, gatherQuery(asked), tick(5));
    expect(short).toContain("Sorry, that is not a number we can call. It needs ten digits with the area code. Type the number to call you back on");
    expect(gatherQuery(short)).toContain("t=2");
    const premium = await webhook("callback-typed", { CallSid: sid, Digits: "19005550100" }, gatherQuery(short), tick(5));
    expect(premium).toContain("Sorry, we cannot call that kind of number back.");
    const own = await webhook("callback-typed", { CallSid: sid, Digits: MAIN.slice(2) }, gatherQuery(premium), tick(5));
    expect(own).toContain("<Say>Sorry, that is our own number, so we cannot call you back on it. We will use the number you are calling from.</Say>");
    expect(own).toContain("We will call you back on 5 1 2, 5 5 5, 8 2 7 3 when it is your turn");
    expect(await callbackOf(sid)).toMatchObject({ callback_e164: "+15125558273", not_before: null });
    expect(await routedOf(sid)).toContain("Tried to give another number to be called back on 3 times and none could be used");
  });

  it("types again on 2, and keeps the number they called from when the read back is not confirmed", async () => {
    await clearLine();
    const { sid, left } = await askForCallback("+15125558274");
    const asked = await webhook("callback-number", { CallSid: sid, Digits: "2" }, gatherQuery(left), tick(2));
    const first = await webhook("callback-typed", { CallSid: sid, Digits: "5125550148#" }, gatherQuery(asked), tick(5));
    const again = await webhook("callback-confirm", { CallSid: sid, Digits: "2" }, gatherQuery(first), tick(3));
    expect(again).toContain("Type the number to call you back on");
    const second = await webhook("callback-typed", { CallSid: sid, Digits: "15125550149" }, gatherQuery(again), tick(5));
    expect(second).toContain("You typed 5 1 2, 5 5 5, 0 1 4 9.");
    /** Nothing pressed: the redirect after the read back brings them to the same step with no digits. */
    expect(second).toContain(`<Redirect method="POST">${attribute(second, "Gather", "action").replace(/&/g, "&amp;")}</Redirect>`);
    const silent = await webhook("callback-confirm", { CallSid: sid }, gatherQuery(second), tick(6));
    expect(silent).toContain("<Say>Nothing has changed.</Say>");
    expect(silent).toContain("We will call you back on 5 1 2, 5 5 5, 8 2 7 4");
    expect(await callbackOf(sid)).toMatchObject({ callback_e164: "+15125558274", not_before: null });
  });

  it("frees the callback to be rung for at once when the caller hangs up while typing", async () => {
    await clearLine();
    const { sid, left } = await askForCallback("+15125558275");
    await webhook("callback-number", { CallSid: sid, Digits: "2" }, gatherQuery(left), tick(2));
    expect((await callbackOf(sid)).not_before).not.toBeNull();
    placed.length = 0;
    await webhook("status", { CallSid: sid, CallStatus: "completed", CallDuration: "30" }, "", tick(4));
    expect((await callbackOf(sid)).not_before).toBeNull();
    expect(placed.length).toBeGreaterThan(0);
    expect(placed[0]!.get("To")).toBe(SAM_PHONE);
  });

  it("changes nothing once somebody is already ringing them back", async () => {
    await clearLine();
    const { sid, left } = await askForCallback("+15125558276");
    const asked = await webhook("callback-number", { CallSid: sid, Digits: "2" }, gatherQuery(left), tick(2));
    const typed = await webhook("callback-typed", { CallSid: sid, Digits: "5125550150" }, gatherQuery(asked), tick(5));
    await raw`update public.queue_callback set status = 'calling' where id = ${(await callbackOf(sid)).id}`;
    const late = await webhook("callback-confirm", { CallSid: sid, Digits: "1" }, gatherQuery(typed), tick(2));
    expect(late).toContain("<Say>Thanks. Goodbye.</Say><Hangup/>");
    expect((await callbackOf(sid)).callback_e164).toBe("+15125558276");
  });
});
