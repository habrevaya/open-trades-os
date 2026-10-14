import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { voice as coreVoice, type Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as softphone from "../src/services/softphone";
import * as transfers from "../src/services/call-transfers";
import * as callbacks from "../src/services/queue-callbacks";
import * as callQueues from "../src/services/call-queues";
import * as phoneMenus from "../src/services/phone-menus";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * HOLD AND PASSING A CALL ON, FROM THE BROWSER PHONE
 *
 * Casey answers a caller in the browser. She puts them on hold and takes them
 * back; passes the next one cold to the billing group, where Lee picks up;
 * passes another warm, talking to Lee first and then handing over; changes
 * her mind on a fourth. Nobody but the person who has the caller can move
 * them, a caller left on hold too long goes to voicemail with a task for the
 * office, and a carrier that refuses to move the call leaves the caller with
 * Casey and says so.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in, and every carrier request is signed as Twilio signs it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("transfers:org");
const OWNER = fixtureId("transfers:owner");
const CASEY = fixtureId("transfers:casey");
const LEE = fixtureId("transfers:lee");
const TECH = fixtureId("transfers:tech");
const AUTH = "a-twilio-auth-token-for-transfers";
const TOKEN = "t".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125559000";
const CASEY_PHONE = "+15125559102";
const LEE_PHONE = "+15125559103";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({ actor: { userId, organizationId: ORG, roles }, db: db() });
const owner = () => as(OWNER, ["owner"]);
const casey = () => as(CASEY, ["csr"]);
const lee = () => as(LEE, ["csr"]);
const tech = () => as(TECH, ["technician"]);

const asked: { url: string; body: URLSearchParams }[] = [];
let refuseRedirects = false;
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  asked.push({ url: to, body });
  if (to.endsWith("/Applications.json")) return Response.json({ sid: "APbrowser" });
  if (/\/Calls\/[^/]+\.json$/.test(to)) {
    if (refuseRedirects) return Response.json({ code: 21220, message: "Call is not in-progress." }, { status: 400 });
    return Response.json({ sid: "CAmoved" });
  }
  if (to.endsWith("/Calls.json")) return Response.json({ sid: `CAleg${asked.length}` });
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const secrets: Record<string, string> = { TEST_TWILIO_TOKEN: AUTH, TEST_API_KEY_SECRET: "an-api-key-secret" };
const deps: voice.VoiceDeps = {
  readSecret: async (ref) => {
    const value = secrets[ref];
    if (!value) throw new ConflictError(`Nothing under ${ref}`);
    return value;
  },
  provider, publicBase: BASE,
};

let clock = Date.now();
async function webhook(step: voice.Step, form: Record<string, string>, query = "") {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}${query}`;
  return voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  }, deps, new Date((clock += 2_000)));
}

const attribute = (twiml: string, verb: string, name: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${name}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${name} in ${twiml}`);
  return match[1]!.replace(/&amp;/g, "&");
};
const queryOf = (address: string) => address.slice(address.indexOf("?"));
const browserOf = (userId: string) => `client:${coreVoice.softphoneIdentity(userId)}`;
/** The last request that moved a call at the carrier, and where to. */
const lastMove = () => [...asked].reverse().find((a) => /\/Calls\/[^/]+\.json$/.test(a.url));

async function member(userId: string, key: string, role: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${key.replace(/ /g, ".")}@transfers.test`}, ${key})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role}::member_role)`;
}

let billingId = "";
let lineId = "";

/** A caller rings and presses 1, and Casey picks up in the browser. */
async function caseyAnswers(from: string) {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const answered = await webhook("incoming", { CallSid: sid, From: from, To: MAIN });
  const pressed = await webhook("menu", { CallSid: sid, Digits: "1" }, queryOf(attribute(answered.twiml!, "Gather", "action")));
  expect(pressed.twiml).toContain(`<Client url="${BASE}/api/webhooks/voice/${TOKEN}/whisper">`);
  await webhook("whisper", { CallSid: `CAbrowser${sid}`, ParentCallSid: sid, To: browserOf(CASEY) });
  const [row] = await raw<{ id: string }[]>`select id from public.call where provider_call_id = ${`twilio:${sid}`}`;
  return { sid, id: row!.id, dial: queryOf(attribute(pressed.twiml!, "Dial", "action")) };
}

async function routed(sid: string): Promise<string> {
  const [row] = await raw<{ routed_because: string }[]>`select routed_because from public.call where provider_call_id = ${`twilio:${sid}`}`;
  return row!.routed_because;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Transfer Heating", slug: "call-transfers-co" });
  await member(CASEY, "Casey Office", "csr");
  await member(LEE, "Lee Office", "csr");
  await member(TECH, "Terry Tech", "technician");
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  const [main] = await raw<{ id: string }[]>`
    insert into public.phone_number (organization_id, e164, purpose, provider_number_id) values (${ORG}, ${MAIN}, 'main', 'PNmain') returning id`;
  await softphone.setup(owner(), { apiKeySid: `SK${"b".repeat(32)}`, apiKeySecretRef: "TEST_API_KEY_SECRET", callerIdNumberId: main!.id }, deps);
  await phoneMenus.setAnsweringPhone(owner(), { userId: CASEY, e164: CASEY_PHONE });
  await phoneMenus.setAnsweringPhone(owner(), { userId: LEE, e164: LEE_PHONE });
  const office = await phoneMenus.saveRingGroup(owner(), {
    name: "Office", strategy: "all_at_once", members: [{ userId: CASEY }], noAnswerTo: { kind: "voicemail", box: "main" },
  });
  billingId = (await phoneMenus.saveRingGroup(owner(), {
    name: "Billing", strategy: "all_at_once", members: [{ userId: LEE }], noAnswerTo: { kind: "voicemail", box: "main" },
  })).id;
  lineId = (await callQueues.saveQueue(owner(), {
    name: "Billing line", ringGroupId: billingId, overflowTo: { kind: "voicemail", box: "main" },
  })).id;
  const menu = await phoneMenus.saveMenu(owner(), {
    name: "Main", greeting: "Thanks for calling.", options: [{ key: "1", label: "The office", to: { kind: "ring_group", id: office.id } }],
    noInputTo: { kind: "voicemail", box: "main" },
  });
  await raw`update public.phone_number set menu_id = ${menu.id} where id = ${main!.id}`;
  await softphone.presence(casey(), { available: true });
});

afterAll(async () => { if (raw) await raw.end(); });

run("hold", () => {
  let call: Awaited<ReturnType<typeof caseyAnswers>>;

  it("knows the call Casey picked up in the browser as hers", async () => {
    call = await caseyAnswers("+15125559171");
    expect(await transfers.current(casey())).toMatchObject({ id: call.id, from: "+15125559171", state: "talking", transferId: null });
    expect(await transfers.current(lee())).toBeNull();
  });

  it("lets nobody else move her caller, and no technician at all", async () => {
    await expect(transfers.hold(lee(), { id: call.id }, deps)).rejects.toThrow(/not yours to move/);
    await expect(transfers.hold(tech(), { id: call.id }, deps)).rejects.toThrow();
    await expect(transfers.hold(owner(), { id: call.id }, deps)).rejects.toThrow(/not yours to move/);
  });

  it("moves the caller's leg to a queue of their own with music, once however often it is pressed", async () => {
    asked.length = 0;
    const held = await transfers.hold(casey(), { id: call.id }, deps);
    expect(held.state).toBe("holding");
    const moved = lastMove()!;
    expect(moved.url).toContain(`/Calls/${call.sid}.json`);
    expect(moved.body.get("Url")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/hold?c=${call.id}`);
    expect(await transfers.hold(casey(), { id: call.id }, deps)).toEqual(held);
    expect(asked.filter((a) => /\/Calls\/[^/]+\.json$/.test(a.url))).toHaveLength(1);
    expect(await transfers.current(casey())).toMatchObject({ state: "holding", transferId: held.id });

    const queued = await webhook("hold", { CallSid: call.sid }, `?c=${call.id}`);
    expect(queued.twiml).toContain(`>ots-hold-${call.id}</Enqueue>`);
    const music = await webhook("hold-wait", { CallSid: call.sid, QueueTime: "0" }, queryOf(attribute(queued.twiml!, "Enqueue", "waitUrl")));
    expect(music.twiml).toContain("<Say>Please hold.</Say><Play>");

    /** The ring group's dial ended because the leg moved: that changes nothing on the call. */
    const ended = await webhook("dialed", { CallSid: call.sid, DialCallStatus: "completed", DialCallDuration: "30" }, call.dial);
    expect(ended.twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const [row] = await raw<{ status: string }[]>`select status from public.call where id = ${call.id}`;
    expect(row!.status).toBe("ringing");
  });

  it("lets Casey take the caller back from the browser, and nobody else", async () => {
    const other = await webhook("softphone", { CallSid: "CAleeback", From: browserOf(LEE), To: `hold:${call.id}` });
    expect(other.twiml).toContain("That caller is no longer on hold for you.");

    const back = await webhook("softphone", { CallSid: "CAcaseyback", From: browserOf(CASEY), To: `hold:${call.id}` });
    expect(back.twiml).toContain(`>ots-hold-${call.id}</Queue></Dial>`);
    await webhook("hold-pickup", { CallSid: call.sid, DequeingCallSid: "CAcaseyback" }, queryOf(attribute(back.twiml!, "Queue", "url")));
    expect(await transfers.current(casey())).toMatchObject({ id: call.id, state: "talking", transferId: null });
    const [t] = await raw<{ status: string }[]>`select status from public.call_transfer where call_id = ${call.id}`;
    expect(t!.status).toBe("taken_back");
  });

  it("sends a caller left on hold too long to voicemail, and gives the office a task to call them", async () => {
    await transfers.hold(casey(), { id: call.id }, deps);
    const gone = await webhook("hold-wait", { CallSid: call.sid, QueueTime: String(transfers.HOLD_MAX_SECONDS) }, `?c=${call.id}`);
    expect(gone.twiml).toContain("<Leave/>");
    const done = await webhook("hold-done", { CallSid: call.sid, QueueResult: "leave", QueueTime: String(transfers.HOLD_MAX_SECONDS) }, `?c=${call.id}`);
    expect(done.twiml).toContain("<Record ");
    expect(await routed(call.sid)).toContain("Was left on hold for 15 minutes, so it went to voicemail.");
    const [task] = await raw<{ priority: string }[]>`select priority from public.task where organization_id = ${ORG} and title = 'Call back +15125559171'`;
    expect(task!.priority).toBe("high");
  });
});

run("passing a caller on cold", () => {
  it("sends the caller to the billing group, where Lee picks up and has them", async () => {
    const call = await caseyAnswers("+15125559172");
    asked.length = 0;
    const sent = await transfers.transfer(casey(), { id: call.id, to: { kind: "ring_group", id: billingId } }, deps);
    expect(sent).toMatchObject({ state: "sent", consult: null });
    expect(lastMove()!.body.get("Url")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/transfer?t=${sent.id}`);
    expect(await transfers.current(casey())).toBeNull();
    expect((await callbacks.busyUsers(db(), ORG, new Date(clock))).has(CASEY)).toBe(false);

    const rung = await webhook("transfer", { CallSid: call.sid }, `?t=${sent.id}`);
    expect(rung.twiml).toContain(`<Number>${LEE_PHONE}</Number>`);
    expect(await routed(call.sid)).toContain("Passed on by Casey Office to the Billing ring group.");
    await webhook("whisper", { CallSid: "CAleeleg", ParentCallSid: call.sid, To: LEE_PHONE });
    expect(await transfers.current(lee())).toMatchObject({ id: call.id, state: "talking" });
    expect((await callbacks.busyUsers(db(), ORG, new Date(clock))).has(LEE)).toBe(true);
  });

  it("sends a caller to a waiting line, and to a colleague's browser when they take calls there", async () => {
    const call = await caseyAnswers("+15125559173");
    const sent = await transfers.transfer(casey(), { id: call.id, to: { kind: "queue", id: lineId } }, deps);
    const line = await webhook("transfer", { CallSid: call.sid }, `?t=${sent.id}`);
    expect(line.twiml).toContain(`>ots-${lineId}</Enqueue>`);

    await softphone.presence(lee(), { available: true });
    try {
      const next = await caseyAnswers("+15125559174");
      const toLee = await transfers.transfer(casey(), { id: next.id, to: { kind: "person", userId: LEE } }, deps);
      const rung = await webhook("transfer", { CallSid: next.sid }, `?t=${toLee.id}`);
      expect(rung.twiml).toContain(`>${coreVoice.softphoneIdentity(LEE)}</Client>`);
    } finally {
      await softphone.presence(lee(), { available: false });
    }
  });

  it("refuses passing to yourself, and talking first to anything but a colleague", async () => {
    const call = await caseyAnswers("+15125559175");
    await expect(transfers.transfer(casey(), { id: call.id, to: { kind: "person", userId: CASEY } }, deps)).rejects.toThrow(/already with you/);
    await expect(transfers.transfer(casey(), { id: call.id, to: { kind: "ring_group", id: billingId }, warm: true }, deps))
      .rejects.toThrow(/works with one colleague/);
    await webhook("status", { CallSid: call.sid, CallStatus: "completed", CallDuration: "20" });
    expect(await transfers.current(casey())).toBeNull();
  });

  it("leaves the caller with Casey, and says so, when Twilio will not move the call", async () => {
    const call = await caseyAnswers("+15125559176");
    refuseRedirects = true;
    try {
      await expect(transfers.transfer(casey(), { id: call.id, to: { kind: "ring_group", id: billingId } }, deps))
        .rejects.toThrow(/Twilio would not pass the caller on: Call is not in-progress\. The caller is still with you\./);
      await expect(transfers.hold(casey(), { id: call.id }, deps)).rejects.toThrow(/would not put the caller on hold/);
    } finally {
      refuseRedirects = false;
    }
    expect(await transfers.current(casey())).toMatchObject({ id: call.id, state: "talking" });
    await webhook("status", { CallSid: call.sid, CallStatus: "completed", CallDuration: "20" });
  });
});

run("passing a caller on warm", () => {
  it("holds the caller, rings Lee from the browser, and hands over once she has picked up", async () => {
    const call = await caseyAnswers("+15125559177");
    const pass = await transfers.transfer(casey(), { id: call.id, to: { kind: "person", userId: LEE }, warm: true }, deps);
    expect(pass).toEqual({ id: pass.id, state: "consulting", consult: `transfer:${pass.id}` });
    expect(lastMove()!.body.get("Url")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/hold?c=${call.id}`);
    expect(await transfers.current(casey())).toMatchObject({ state: "consulting", consultWith: "Lee Office", consultAnswered: false });
    await expect(transfers.complete(casey(), { id: pass.id }, deps)).rejects.toThrow(/have not picked up yet/);

    const ring = await webhook("softphone", { CallSid: "CAconsult", From: browserOf(CASEY), To: pass.consult! });
    expect(ring.twiml).toContain(`<Number url="${BASE}/api/webhooks/voice/${TOKEN}/transfer-answered?t=${pass.id}">${LEE_PHONE}</Number>`);
    expect(attribute(ring.twiml!, "Dial", "callerId")).toBe(MAIN);
    const told = await webhook("transfer-answered", { CallSid: "CAleeconsult", ParentCallSid: "CAconsult" }, `?t=${pass.id}`);
    expect(told.twiml).toContain("Casey Office would like to pass you a caller from 5 1 2, 5 5 5, 9 1 7 7.");
    await expect(transfers.complete(lee(), { id: pass.id }, deps)).rejects.toThrow(/Only the person passing the call on/);

    asked.length = 0;
    expect(await transfers.complete(casey(), { id: pass.id }, deps)).toEqual({ id: pass.id, state: "handing_over" });
    const moved = lastMove()!;
    expect(moved.url).toContain("/Calls/CAleeconsult.json");
    expect(moved.body.get("Url")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/transfer-bridge?t=${pass.id}`);

    const bridge = await webhook("transfer-bridge", { CallSid: "CAleeconsult" }, `?t=${pass.id}`);
    expect(bridge.twiml).toContain(`>ots-hold-${call.id}</Queue></Dial>`);
    await webhook("hold-pickup", { CallSid: call.sid, DequeingCallSid: "CAleeconsult" }, queryOf(attribute(bridge.twiml!, "Queue", "url")));
    const over = await webhook("transfer-consult-done", { CallSid: "CAconsult", DialCallStatus: "completed" }, `?t=${pass.id}`);
    expect(over.twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');

    expect(await transfers.current(lee())).toMatchObject({ id: call.id, state: "talking" });
    expect(await transfers.current(casey())).toBeNull();
    expect(await routed(call.sid)).toContain("Handed over to Lee Office after talking to them first.");
  });

  it("keeps the caller on hold when Casey calls the pass off, ending Lee's call", async () => {
    const call = await caseyAnswers("+15125559178");
    const pass = await transfers.transfer(casey(), { id: call.id, to: { kind: "person", userId: LEE }, warm: true }, deps);
    await webhook("transfer-answered", { CallSid: "CAleeconsult2" }, `?t=${pass.id}`);
    asked.length = 0;
    expect(await transfers.cancel(casey(), { id: pass.id }, deps)).toEqual({ id: pass.id, state: "holding" });
    const ended = lastMove()!;
    expect(ended.url).toContain("/Calls/CAleeconsult2.json");
    expect(ended.body.get("Status")).toBe("completed");
    expect(await transfers.current(casey())).toMatchObject({ state: "holding", consultWith: null });
  });

  it("keeps the caller on hold when the colleague does not pick up, and tells the person passing it", async () => {
    const call = await caseyAnswers("+15125559179");
    const pass = await transfers.transfer(casey(), { id: call.id, to: { kind: "person", userId: LEE }, warm: true }, deps);
    const done = await webhook("transfer-consult-done", { CallSid: "CAconsult3", DialCallStatus: "no-answer" }, `?t=${pass.id}`);
    expect(done.twiml).toContain("They did not pick up. Your caller is still on hold.");
    expect(await transfers.current(casey())).toMatchObject({ state: "holding" });
  });

  it("names who can be passed a caller, to anybody who may place calls", async () => {
    const targets = await transfers.targets(casey());
    expect(targets.people.map((p) => p.name)).toEqual(["Lee Office"]);
    expect(targets.ringGroups.map((g) => g.name)).toEqual(["Billing", "Office"]);
    expect(targets.queues.map((q) => q.name)).toEqual(["Billing line"]);
    await expect(transfers.targets(tech())).rejects.toThrow();
  });
});
