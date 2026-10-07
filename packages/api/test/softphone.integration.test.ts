import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createHmac, randomBytes } from "node:crypto";
import { voice as coreVoice, type Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as softphone from "../src/services/softphone";
import * as phoneMenus from "../src/services/phone-menus";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE BROWSER PHONE
 *
 * An owner sets browser calling up on the company's own Twilio account; the
 * office gets a pass for its browser and a technician does not; a person
 * taking calls in the browser is rung there instead of on their phone; and a
 * call placed from the browser goes out from the company's number, logged,
 * with the person called asked before anything is recorded.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in, and every carrier request is signed as Twilio signs it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("softphone:org");
const OWNER = fixtureId("softphone:owner");
const CSR = fixtureId("softphone:csr");
const TECH = fixtureId("softphone:tech");
const SLUG = "softphone-co";
const AUTH = "a-twilio-auth-token-for-the-browser";
const KEY_SID = `SK${"a".repeat(32)}`;
const KEY_SECRET = "the-api-key-secret-not-a-real-one";
const TOKEN = "s".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125556000";
const CSR_PHONE = "+15125556102";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({ actor: { userId, organizationId: ORG, roles }, db: db() });
const owner = () => as(OWNER, ["owner"]);
const csr = () => as(CSR, ["csr"]);
const tech = () => as(TECH, ["technician"]);

const asked: { method: string; url: string; body: string }[] = [];
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  const body = init?.body ? String(init.body) : "";
  asked.push({ method: init?.method ?? "GET", url: to, body });
  if (to.endsWith("/Applications.json")) return Response.json({ sid: "APbrowser" });
  if (to.includes("/Applications/")) return Response.json({ sid: "APbrowser" });
  if (to.includes("/Recordings.json")) return Response.json({ sid: "REbrowser" });
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const secrets: Record<string, string> = { TEST_TWILIO_TOKEN: AUTH, TEST_API_KEY_SECRET: KEY_SECRET };
const deps: voice.VoiceDeps = {
  readSecret: async (ref) => {
    const value = secrets[ref];
    if (!value) throw new ConflictError(`Nothing under ${ref}`);
    return value;
  },
  provider, publicBase: BASE,
};

let clock = Date.now();
async function webhook(step: voice.Step, form: Record<string, string>, query = "", signedWith = AUTH) {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}${query}`;
  return voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(signedWith, to, form) },
  }, deps, new Date((clock += 2_000)));
}

const attribute = (twiml: string, verb: string, name: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${name}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${name} in ${twiml}`);
  return match[1]!.replace(/&amp;/g, "&");
};
const queryOf = (address: string) => address.slice(address.indexOf("?"));

async function member(userId: string, key: string, role: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${key}@softphone.test`}, ${key})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role}::member_role)`;
}

let mainId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Softphone Heating", slug: SLUG });
  await member(CSR, "Casey Office", "csr");
  await member(TECH, "Terry Tech", "technician");
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  const [main] = await raw<{ id: string }[]>`
    insert into public.phone_number (organization_id, e164, purpose, provider_number_id)
    values (${ORG}, ${MAIN}, 'main', 'PNmain') returning id`;
  mainId = main!.id;
  await raw`insert into public.customer (organization_id, name, phone) values (${ORG}, 'Pat Customer', '(512) 555-6199')`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("setting browser calling up", () => {
  it("is not ready before an owner sets it up, and says so", async () => {
    const status = await softphone.status(csr());
    expect(status).toMatchObject({ ready: false, takingCalls: false });
    expect(status.reason).toContain("not set up");
    await expect(softphone.token(csr(), deps)).rejects.toThrow(/not set up/);
  });

  it("refuses an API key in the wrong form, a secret name with nothing behind it, and a number not answered here", async () => {
    await expect(softphone.setup(owner(), { apiKeySid: "AC123", apiKeySecretRef: "TEST_API_KEY_SECRET", callerIdNumberId: mainId }, deps))
      .rejects.toThrow(/starts with SK/);
    await expect(softphone.setup(owner(), { apiKeySid: KEY_SID, apiKeySecretRef: "NOTHING_HERE", callerIdNumberId: mainId }, deps))
      .rejects.toThrow(/Nothing is stored under NOTHING_HERE/);
    const [typed] = await raw<{ id: string }[]>`
      insert into public.phone_number (organization_id, e164, purpose) values (${ORG}, '+15125556001', 'tracking') returning id`;
    await expect(softphone.setup(owner(), { apiKeySid: KEY_SID, apiKeySecretRef: "TEST_API_KEY_SECRET", callerIdNumberId: typed!.id }, deps))
      .rejects.toThrow(/is not answered here/);
  });

  it("refuses anybody but somebody who changes settings", async () => {
    await expect(softphone.setup(csr(), { apiKeySid: KEY_SID, apiKeySecretRef: "TEST_API_KEY_SECRET", callerIdNumberId: mainId }, deps))
      .rejects.toThrow();
  });

  it("makes the application on the company's own account, pointed at this installation", async () => {
    asked.length = 0;
    const done = await softphone.setup(owner(), { apiKeySid: KEY_SID, apiKeySecretRef: "TEST_API_KEY_SECRET", callerIdNumberId: mainId }, deps);
    expect(done).toEqual({ ready: true, applicationSid: "APbrowser", callerId: MAIN });
    const made = asked.find((a) => a.url.endsWith("/Applications.json"))!;
    expect(new URLSearchParams(made.body).get("VoiceUrl")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/softphone`);
    /** The secret is named, never stored. */
    const [row] = await raw<{ settings: Record<string, unknown> }[]>`
      select settings from public.integration_connection where organization_id = ${ORG} and capability = 'messaging'`;
    expect(JSON.stringify(row!.settings)).not.toContain(KEY_SECRET);

    asked.length = 0;
    await softphone.setup(owner(), { apiKeySid: KEY_SID, apiKeySecretRef: "TEST_API_KEY_SECRET", callerIdNumberId: mainId }, deps);
    expect(asked[0]!.url).toContain("/Applications/APbrowser.json");
  });
});

run("a pass for the browser", () => {
  it("is minted for the office, signed with the API key, naming only the person asking", async () => {
    const minted = await softphone.token(csr(), deps, new Date("2026-10-05T15:00:00Z"));
    const [header, payload, signature] = minted.token.split(".");
    expect(createHmac("sha256", KEY_SECRET).update(`${header}.${payload}`).digest("base64url")).toBe(signature);
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: KEY_SID, sub: "ACtest", exp: Date.parse("2026-10-05T16:00:00Z") / 1000,
      grants: { identity: coreVoice.softphoneIdentity(CSR), voice: { incoming: { allow: true }, outgoing: { application_sid: "APbrowser" } } },
    });
    expect(minted.identity).toBe(coreVoice.softphoneIdentity(CSR));
  });

  it("is refused to a technician, who rings from their own phone", async () => {
    await expect(softphone.token(tech(), deps)).rejects.toThrow();
    await expect(softphone.status(tech())).rejects.toThrow();
  });
});

run("a call to the company rings a browser", () => {
  it("rings a person taking calls in the browser there instead of on their phone", async () => {
    await phoneMenus.setAnsweringPhone(owner(), { userId: CSR, e164: CSR_PHONE });
    const group = await phoneMenus.saveRingGroup(owner(), {
      name: "Office", strategy: "all_at_once", members: [{ userId: CSR }], noAnswerTo: { kind: "voicemail", box: "main" },
    });
    const menu = await phoneMenus.saveMenu(owner(), {
      name: "Main", greeting: "Thanks for calling.", options: [{ key: "1", label: "The office", to: { kind: "ring_group", id: group.id } }],
      noInputTo: { kind: "voicemail", box: "main" },
    });
    await raw`update public.phone_number set menu_id = ${menu.id} where id = ${mainId}`;

    const ring = async () => {
      const sid = `CA${randomBytes(8).toString("hex")}`;
      const answered = await webhook("incoming", { CallSid: sid, From: "+15125556177", To: MAIN });
      const pressed = await webhook("menu", { CallSid: sid, Digits: "1" }, queryOf(attribute(answered.twiml!, "Gather", "action")));
      return { sid, twiml: pressed.twiml! };
    };

    expect((await ring()).twiml).toContain(`<Number>${CSR_PHONE}</Number>`);

    expect(await softphone.presence(csr(), { available: true })).toEqual({ takingCalls: true });
    const browser = await ring();
    expect(browser.twiml).toContain(`<Client url="${BASE}/api/webhooks/voice/${TOKEN}/whisper">${coreVoice.softphoneIdentity(CSR)}</Client>`);
    expect(browser.twiml).not.toContain(CSR_PHONE);

    /** Picked up in the browser: the call knows who answered. */
    await webhook("whisper", { CallSid: "CAchild", ParentCallSid: browser.sid, To: `client:${coreVoice.softphoneIdentity(CSR)}` });
    const [row] = await raw<{ answered_by_user_id: string }[]>`
      select answered_by_user_id from public.call where provider_call_id = ${`twilio:${browser.sid}`}`;
    expect(row!.answered_by_user_id).toBe(CSR);

    await softphone.presence(csr(), { available: false });
    expect((await ring()).twiml).toContain(`<Number>${CSR_PHONE}</Number>`);
  });
});

run("a call placed from the browser", () => {
  const from = `client:${coreVoice.softphoneIdentity(CSR)}`;

  it("goes out from the company's number, logged against the customer it rings", async () => {
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const placed = await webhook("softphone", { CallSid: sid, From: from, To: "(512) 555-6199" });
    expect(placed.twiml).toContain(`callerId="${MAIN}"`);
    expect(placed.twiml).toContain("<Number>+15125556199</Number>");
    expect(placed.twiml).not.toContain("softphone-consent");
    const [call] = await raw<{ direction: string; placed_by_user_id: string; from_e164: string; to_e164: string; customer_id: string | null }[]>`
      select direction, placed_by_user_id, from_e164, to_e164, customer_id from public.call where provider_call_id = ${`twilio:${sid}`}`;
    expect(call).toMatchObject({ direction: "outbound", placed_by_user_id: CSR, from_e164: MAIN, to_e164: "+15125556199" });
    expect(call!.customer_id).not.toBeNull();

    const before = await raw<{ n: number }[]>`select count(*)::int as n from public.domain_event where organization_id = ${ORG} and name = 'call.missed'`;
    await webhook("softphone-dialed", { CallSid: sid, DialCallStatus: "no-answer", DialCallDuration: "0" });
    await webhook("status", { CallSid: sid, CallStatus: "completed", CallDuration: "31" });
    const after = await raw<{ n: number }[]>`select count(*)::int as n from public.domain_event where organization_id = ${ORG} and name = 'call.missed'`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("refuses somebody who may not place calls, an emergency number, and a forged request", async () => {
    const techCall = await webhook("softphone", { CallSid: "CAtech", From: `client:${coreVoice.softphoneIdentity(TECH)}`, To: "5125556199" });
    expect(techCall.twiml).toContain("You are not allowed to place calls from the browser.");
    const emergency = await webhook("softphone", { CallSid: "CA911", From: from, To: "911" });
    expect(emergency.twiml).toContain("Emergency calls cannot be made from the browser");
    const forged = await webhook("softphone", { CallSid: "CAforged", From: from, To: "5125556199" }, "", "not-the-token");
    expect(forged.status).toBe(403);
    const [missed] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.call where provider_call_id in ('twilio:CAtech', 'twilio:CA911', 'twilio:CAforged')`;
    expect(missed!.n).toBe(0);
  });

  it("asks the person called before recording, and records only on their yes", async () => {
    await raw`update public.phone_number set record_calls = true where id = ${mainId}`;
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const placed = await webhook("softphone", { CallSid: sid, From: from, To: "5125556199" });
    const ask = attribute(placed.twiml!, "Number", "url");
    expect(ask).toContain("/softphone-consent?");

    const question = await webhook("softphone-consent", { CallSid: "CAcallee", ParentCallSid: sid }, queryOf(ask));
    expect(question.twiml).toContain("Softphone Heating is calling. This call can be recorded");
    const answer = attribute(question.twiml!, "Gather", "action");

    asked.length = 0;
    await webhook("softphone-consent", { CallSid: "CAcallee", ParentCallSid: sid, Digits: "1" }, queryOf(answer));
    const started = asked.find((a) => a.url.includes(`/Calls/${sid}/Recordings.json`));
    expect(started).toBeDefined();
    expect(new URLSearchParams(started!.body).get("RecordingStatusCallback")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/recording`);
    const [yes] = await raw<{ recording_started_at: Date | null }[]>`
      select recording_started_at from public.call where provider_call_id = ${`twilio:${sid}`}`;
    expect(yes!.recording_started_at).not.toBeNull();

    const quiet = `CA${randomBytes(8).toString("hex")}`;
    const second = await webhook("softphone", { CallSid: quiet, From: from, To: "5125556199" });
    asked.length = 0;
    await webhook("softphone-consent", { CallSid: "CAcallee2", ParentCallSid: quiet }, queryOf(attribute(second.twiml!, "Number", "url")).replace("a=ask", "a=answer"));
    expect(asked.some((a) => a.url.includes("/Recordings.json"))).toBe(false);
    const [no] = await raw<{ recording_started_at: Date | null; recording_refusal: string | null }[]>`
      select recording_started_at, recording_refusal from public.call where provider_call_id = ${`twilio:${quiet}`}`;
    expect(no!.recording_started_at).toBeNull();
    expect(no!.recording_refusal).not.toBeNull();
    await raw`update public.phone_number set record_calls = false where id = ${mainId}`;
  });

  it("takes a carrier field named __proto__ or constructor as a field, not as a way into the prototype", async () => {
    const form: Record<string, string> = Object.fromEntries([
      ["CallSid", "CAproto1"], ["From", CSR_PHONE], ["To", MAIN],
      ["__proto__", "polluted"], ["constructor", "polluted"], ["toString", "polluted"],
    ]);
    const reply = await webhook("incoming", form);
    expect(reply.status).toBe(200);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(typeof ({} as object).toString).toBe("function");
  });
});
