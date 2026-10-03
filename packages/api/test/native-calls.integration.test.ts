import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as acquisition from "../src/services/acquisition";
import * as customers from "../src/services/customers";
import * as voice from "../src/services/voice";
import * as websiteTracking from "../src/services/website-tracking";
import * as telephony from "../src/services/telephony";
import * as callTracking from "../src/services/call-tracking";
import * as workflows from "../src/services/workflows";
import { handleEvent } from "../src/services/workflow-runner";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import type { TrackedCall } from "../src/call-tracking/provider";
import { TooManyRequestsError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A TRACKING NUMBER BOUGHT HERE, AND EVERY CALL TO IT
 *
 * The company buys a number from its own Twilio account, a caller rings it,
 * is asked about recording, is whispered to the office, is not answered,
 * leaves a voicemail and is texted back; a website visitor is shown a pool
 * number and their click id follows them onto the call. Every step goes
 * through the webhook handler the route calls, with the carrier's own
 * signature on every request.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in, so the requests it shapes are checked as well as the
 * answers the service gives.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("native:org");
const USER = fixtureId("native:user");
const SLUG = "native-calls-co";
const AUTH = "a-twilio-auth-token-for-the-tests";
const TOKEN = "t".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125557000";
const OFFICE = "+15125557001";
const CALLER = "+15125557050";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

/** Everything the adapter asked Twilio for, and a counter for the numbers it sold. */
const asked: { method: string; url: string; body: string }[] = [];
let sold = 0;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 1, 2, 3]);
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  const body = init?.body ? String(init.body) : "";
  asked.push({ method: init?.method ?? "GET", url: to, body });
  if (to.includes("/AvailablePhoneNumbers/")) {
    return Response.json({ available_phone_numbers: [
      { phone_number: "+15125557100", friendly_name: "(512) 555-7100", locality: "Austin", region: "TX" },
    ] });
  }
  if (to.endsWith("/IncomingPhoneNumbers.json")) {
    sold += 1;
    return Response.json({ sid: `PN${sold}`, phone_number: new URLSearchParams(body).get("PhoneNumber") }, { status: 201 });
  }
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  if (to.endsWith(".mp3")) return new Response(MP3, { status: 200 });
  return Response.json({ message: "unexpected" }, { status: 400 });
};

const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const deps: voice.VoiceDeps = { readSecret: async () => AUTH, provider, publicBase: BASE };

/** A request exactly as Twilio would make it, signed over the public URL. */
function signed(step: string | null, form: Record<string, string>) {
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step ? `/${step}` : ""}`;
  return {
    url: to,
    body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  };
}

async function webhook(step: voice.Step, form: Record<string, string>, now = new Date()) {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  return voice.handle(db(), connection, step, signed(step === "incoming" ? null : step, form), deps, now);
}

let campaignId = "";
let channelId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Native Calls Co", slug: SLUG });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, ${MAIN}, 'main', true)`;
  const google = (await acquisition.listChannels(owner())).find((c) => c.sourceKey === "google_ads")!;
  channelId = google.id;
  campaignId = (await acquisition.createCampaign(owner(), { channelId, name: "Spring AC tune up" })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("buying a number from the company's own Twilio account", () => {
  it("searches by area code through the company's account", async () => {
    const found = await voice.searchNumbers(owner(), { areaCode: "512" }, deps);
    expect(found[0]!.e164).toBe("+15125557100");
    expect(asked.at(-1)!.url).toContain("/Accounts/ACtest/AvailablePhoneNumbers/US/Local.json?");
    expect(asked.at(-1)!.url).toContain("AreaCode=512");
  });

  it("refuses a search for somebody who may not change settings", async () => {
    await expect(voice.searchNumbers(owner(["dispatcher"]), { areaCode: "512" }, deps)).rejects.toThrow();
  });

  it("buys it pointed at this installation's webhooks, credited to the campaign", async () => {
    const number = await voice.buyNumber(owner(), {
      e164: "+15125557100", purpose: "tracking", label: "Spring flyer", campaignId,
      forwardsToE164: OFFICE, whisper: true, recordCalls: true,
    }, deps);
    expect(number.routedHere).toBe(true);
    expect(number.campaignId).toBe(campaignId);
    expect(number.channelId).toBe(channelId);
    const form = new URLSearchParams(asked.find((a) => a.url.endsWith("/IncomingPhoneNumbers.json"))!.body);
    expect(form.get("VoiceUrl")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}`);
    expect(form.get("StatusCallback")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/status`);
    expect(form.get("SmsUrl")).toBe(`${BASE}/api/webhooks/messaging/${TOKEN}`);
  });

  it("answers a repeated purchase with the number it already bought", async () => {
    const before = sold;
    const again = await voice.buyNumber(owner(), { e164: "+15125557100", purpose: "tracking", campaignId }, deps);
    expect(again.e164).toBe("+15125557100");
    expect(sold).toBe(before);
  });

  it("refuses a campaign on a pool number before anything is bought", async () => {
    const before = sold;
    await expect(voice.buyNumber(owner(), { e164: "+15125557199", purpose: "pool", campaignId }, deps))
      .rejects.toThrow(/credited to the visit/);
    expect(sold).toBe(before);
  });

  it("never sends a text from the number it bought", async () => {
    const [sender] = await raw<{ e164: string }[]>`
      select e164 from public.phone_number where organization_id = ${ORG} and released_at is null and purpose = 'main'`;
    expect(sender!.e164).toBe(MAIN);
  });
});

run("a call to a number bought here", () => {
  const SID = `CA${randomBytes(8).toString("hex")}`;
  let callId = "";

  it("refuses a request the carrier did not sign", async () => {
    const connection = (await voice.resolveWebhook(db(), TOKEN, deps))!;
    const request = signed(null, { CallSid: SID, From: CALLER, To: "+15125557100" });
    const reply = await voice.handle(db(), connection, "incoming", { ...request, body: `${request.body}&From=%2B1999` }, deps);
    expect(reply.status).toBe(403);
    expect(await voice.resolveWebhook(db(), "too-short", deps)).toBeNull();
  });

  it("records the call and its touch through the CallRail path, and asks about recording first", async () => {
    const reply = await webhook("incoming", { CallSid: SID, From: CALLER, To: "+15125557100", Direction: "inbound" });
    expect(reply.twiml).toContain("<Gather");
    expect(reply.twiml).toContain("Press 1");
    expect(reply.twiml).not.toContain("record=");

    const [call] = await raw<{ id: string; status: string; acquisition_campaign_id: string; source_system: string; routed_because: string }[]>`
      select id, status, acquisition_campaign_id, source_system, routed_because from public.call
      where organization_id = ${ORG} and provider_call_id = ${`twilio:${SID}`}`;
    callId = call!.id;
    expect(call).toMatchObject({ status: "ringing", acquisition_campaign_id: campaignId, source_system: "twilio" });
    expect(call!.routed_because).toContain("Ring the office");

    const [touch] = await raw<{ source: string; acquisition_campaign_id: string; caller_e164: string }[]>`
      select source, acquisition_campaign_id, caller_e164 from public.marketing_touch where call_id = ${callId}`;
    expect(touch).toMatchObject({ source: "google_ads", acquisition_campaign_id: campaignId, caller_e164: CALLER });
  });

  it("records nothing for a caller who did not press 1, and still connects them", async () => {
    const reply = await webhook("connect", { CallSid: SID });
    expect(reply.twiml).toContain(`<Number url="${BASE}/api/webhooks/voice/${TOKEN}/whisper">${OFFICE}</Number>`);
    expect(reply.twiml).not.toContain("record=");
    const [call] = await raw<{ recording_refusal: string; recording_started_at: Date | null }[]>`
      select recording_refusal, recording_started_at from public.call where id = ${callId}`;
    expect(call).toMatchObject({ recording_refusal: "consent_missing", recording_started_at: null });
  });

  it("discards the carrier's recording of a call nobody allowed to be recorded", async () => {
    asked.length = 0;
    const reply = await webhook("recording", {
      CallSid: SID, RecordingSid: "RE-not-allowed", RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE-not-allowed",
      RecordingStatus: "completed",
    });
    expect(reply.status).toBe(200);
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      "DELETE https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE-not-allowed.json",
    ]);
    const [call] = await raw<{ recording_url: string | null }[]>`select recording_url from public.call where id = ${callId}`;
    expect(call!.recording_url).toBeNull();
  });

  it("whispers the channel and campaign to whoever answers", async () => {
    const reply = await webhook("whisper", { CallSid: "CA-child", ParentCallSid: SID });
    expect(reply.twiml).toContain("Call from Google Ads, Spring AC tune up.");
    expect(reply.twiml).not.toContain("being recorded");
  });

  it("sends an unanswered call to voicemail and tells the workflows it was missed, once", async () => {
    const reply = await webhook("dialed", { CallSid: SID, DialCallStatus: "no-answer" });
    expect(reply.twiml).toContain("<Record");
    await webhook("status", { CallSid: SID, CallStatus: "completed", CallDuration: "41" });
    await webhook("dialed", { CallSid: SID, DialCallStatus: "no-answer" });
    const events = await raw<{ payload: { from: string } }[]>`
      select payload from public.domain_event where organization_id = ${ORG} and name = 'call.missed' and entity_id = ${callId}`;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.from).toBe(CALLER);
    const [call] = await raw<{ status: string; duration_seconds: number }[]>`
      select status, duration_seconds from public.call where id = ${callId}`;
    expect(call).toMatchObject({ status: "no_answer", duration_seconds: 41 });
  });

  it("keeps the voicemail as a stored file and deletes the carrier's copy", async () => {
    asked.length = 0;
    await webhook("voicemail", {
      CallSid: SID, RecordingSid: "RE-voicemail", RecordingStatus: "completed",
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE-voicemail",
    });
    expect(asked.map((a) => a.method)).toEqual(["GET", "DELETE"]);
    const [call] = await raw<{ status: string; voicemail_storage_key: string; voicemail_url: string }[]>`
      select status, voicemail_storage_key, voicemail_url from public.call where id = ${callId}`;
    expect(call!.status).toBe("voicemail");
    expect(call!.voicemail_url).toBe(`/marketing/calls/${callId}/voicemail`);
    const audio = await telephony.recordingAudio(owner(), callId, "voicemail");
    expect(audio.contentType).toBe("audio/mpeg");
  });
});

run("a call the caller agreed to have recorded", () => {
  const SID = `CA${randomBytes(8).toString("hex")}`;
  let callId = "";

  it("records from the answer once the caller presses 1, and says so in the whisper", async () => {
    await webhook("incoming", { CallSid: SID, From: "+15125557051", To: "+15125557100" });
    const reply = await webhook("connect", { CallSid: SID, Digits: "1" });
    expect(reply.twiml).toContain('record="record-from-answer-dual"');
    expect(reply.twiml).toContain(`recordingStatusCallback="${BASE}/api/webhooks/voice/${TOKEN}/recording"`);
    const [call] = await raw<{ id: string; recording_consent: string; recording_started_at: Date | null; announcement_played_at: Date | null }[]>`
      select id, recording_consent, recording_started_at, announcement_played_at from public.call
      where provider_call_id = ${`twilio:${SID}`}`;
    callId = call!.id;
    expect(call!.recording_consent).toBe("unknown");
    expect(call!.recording_started_at).not.toBeNull();
    expect(call!.announcement_played_at).not.toBeNull();
    expect((await webhook("whisper", { CallSid: "CA-c2", ParentCallSid: SID })).twiml).toContain("This call is being recorded.");
  });

  it("answers, so nothing is missed", async () => {
    expect((await webhook("dialed", { CallSid: SID, DialCallStatus: "completed", DialCallDuration: "95" })).twiml).toContain("<Hangup/>");
    await webhook("status", { CallSid: SID, CallStatus: "completed", CallDuration: "110" });
    const missed = await raw`select 1 from public.domain_event where name = 'call.missed' and entity_id = ${callId}`;
    expect(missed).toHaveLength(0);
  });

  it("fetches the recording, keeps it through the recording gate, and deletes the carrier's copy", async () => {
    asked.length = 0;
    await webhook("recording", {
      CallSid: SID, RecordingSid: "RE-kept", RecordingStatus: "completed",
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE-kept",
    });
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      "GET https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE-kept.mp3",
      "DELETE https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE-kept.json",
    ]);
    const [call] = await raw<{ recording_url: string; recording_storage_key: string }[]>`
      select recording_url, recording_storage_key from public.call where id = ${callId}`;
    expect(call!.recording_url).toBe(`/marketing/calls/${callId}/recording`);
    expect((await telephony.recordingAudio(owner(), callId)).bytes.length).toBe(MP3.length);
  });

  it("refuses a recording URL anywhere but the carrier's own API", async () => {
    const fetched = await provider.fetchRecording("https://evil.example/steal");
    expect(fetched.ok).toBe(false);
  });

  it("destroys the kept audio when the recording is deleted", async () => {
    await telephony.deleteRecording(owner(), callId, "The customer asked.");
    await expect(telephony.recordingAudio(owner(), callId)).rejects.toThrow(/not found/);
    const [file] = await raw<{ size_bytes: number; deleted_at: Date | null }[]>`
      select f.size_bytes, f.deleted_at from public.stored_file f
      where f.organization_id = ${ORG} and f.storage_key like '%.mp3' order by f.created_at desc limit 1`;
    expect(file!.deleted_at).not.toBeNull();
  });

  it("deletes recordings past a declared retention, and only under one", async () => {
    expect(await voice.sweepRecordings(db(), ORG)).toBe(0);
  });
});

run("a missed call, texted back", () => {
  it("installs the recommended automation and it texts the caller from the main number, never the tracking one", async () => {
    await workflows.installTemplate(owner(), { key: "missed_call_text_back", values: { minutes: 0 } });
    const SID = `CA${randomBytes(8).toString("hex")}`;
    await webhook("incoming", { CallSid: SID, From: "+15125557052", To: "+15125557100" });
    await webhook("dialed", { CallSid: SID, DialCallStatus: "busy" });
    const [event] = await raw<{ id: string }[]>`
      select id from public.domain_event where organization_id = ${ORG} and name = 'call.missed'
      order by sequence desc limit 1`;
    await handleEvent(owner(), event!.id);

    const [message] = await raw<{ from_address: string; to_address: string; body: string; status: string; automation_ref: string }[]>`
      select from_address, to_address, body, status, automation_ref from public.message
      where organization_id = ${ORG} and to_address = '+15125557052'`;
    expect(message).toMatchObject({ from_address: MAIN, to_address: "+15125557052", status: "queued" });
    expect(message!.body).toContain("Native Calls Co");
    expect(message!.automation_ref).toMatch(/^run:/);
    const tasks = await raw<{ title: string; queue: string }[]>`
      select title, queue from public.task where organization_id = ${ORG} and title like '%+15125557052%'`;
    expect(tasks).toEqual([{ title: "Ring back +15125557052, a missed call", queue: "office" }]);
  });

  it("does not text somebody who replied STOP, and still raises the call back", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, '+15125557053', 'sms', 'inbound: STOP')`;
    const SID = `CA${randomBytes(8).toString("hex")}`;
    await webhook("incoming", { CallSid: SID, From: "+15125557053", To: "+15125557100" });
    await webhook("status", { CallSid: SID, CallStatus: "no-answer" });
    const [event] = await raw<{ id: string }[]>`
      select id from public.domain_event where organization_id = ${ORG} and name = 'call.missed'
      order by sequence desc limit 1`;
    await handleEvent(owner(), event!.id);
    expect(await raw`select 1 from public.message where to_address = '+15125557053'`).toHaveLength(0);
    expect(await raw`select 1 from public.task where organization_id = ${ORG} and title like '%+15125557053%'`).toHaveLength(1);
  });

  it("is emitted for a CallRail call too, once, and only when it is over", async () => {
    const at = new Date();
    const call: TrackedCall = {
      externalId: `CR${randomBytes(4).toString("hex")}`, direction: "inbound", trackingNumber: "+15125557100",
      customerNumber: "+15125557054", businessNumber: null, startedAt: at, durationSeconds: null, answered: false,
      voicemail: false, customerName: null, utm: {}, clickId: null, referrer: null, landingPath: null,
      personId: null, firstCall: null, raw: {},
    };
    const ringing = await callTracking.record(db(), ORG, call, at);
    if (ringing.kind !== "recorded") throw new Error("not recorded");
    const count = () => raw`select 1 from public.domain_event where name = 'call.missed' and entity_id = ${ringing.callId}`;
    expect(await count()).toHaveLength(0);
    await callTracking.record(db(), ORG, { ...call, durationSeconds: 30 }, at);
    await callTracking.record(db(), ORG, { ...call, durationSeconds: 30 }, at);
    expect(await count()).toHaveLength(1);
  });
});

run("a website visitor, their number, and their call", () => {
  const visitor = randomBytes(16).toString("hex");
  const other = randomBytes(16).toString("hex");
  const third = randomBytes(16).toString("hex");
  const ip = `10.${Math.floor(Math.random() * 200)}.0.${Math.floor(Math.random() * 200)}`;
  const meta = { ip };

  it("buys two pool numbers", async () => {
    await voice.buyNumber(owner(), { e164: "+15125557201", purpose: "pool", forwardsToE164: OFFICE }, deps);
    await voice.buyNumber(owner(), { e164: "+15125557202", purpose: "pool", forwardsToE164: OFFICE }, deps);
    const view = await websiteTracking.overview(owner());
    expect(view.companyKey).toBe(SLUG);
    expect(view.pool.map((n) => n.e164).sort()).toEqual(["+15125557201", "+15125557202"]);
  });

  it("records an arrival with only its attribution, and not twice", async () => {
    const first = await websiteTracking.recordVisit(db(), {
      companyKey: SLUG, visitorId: visitor, page: "/ac?utm_source=google&utm_medium=cpc&gclid=GCLID-1&email=x%40y.z",
      referrer: "https://www.google.com/search?q=private+words",
    }, meta);
    expect(first.recorded).toBe(true);
    const again = await websiteTracking.recordVisit(db(), {
      companyKey: SLUG, visitorId: visitor, page: "/contact?utm_source=google&utm_medium=cpc&gclid=GCLID-1",
      referrer: "https://www.google.com/",
    }, meta);
    expect(again.recorded).toBe(false);
    const [touch] = await raw<{ source: string; click_id: string; referrer_host: string; landing_path: string; utm_source: string }[]>`
      select source, click_id, referrer_host, landing_path, utm_source from public.marketing_touch where id = ${first.touchId}`;
    expect(touch).toEqual({ source: "google_ads", click_id: "GCLID-1", referrer_host: "google.com", landing_path: "/ac", utm_source: "google" });
  });

  it("gives each visitor their own pool number, the same one every time they ask", async () => {
    const q = { companyKey: SLUG, query: "utm_source=google&utm_medium=cpc&gclid=GCLID-1", page: "/ac" };
    const mine = await websiteTracking.numberFor(db(), { ...q, visitorId: visitor }, meta);
    expect(mine.pooled).toBe(true);
    expect(mine.targets).toEqual(expect.arrayContaining([MAIN, "+15125557100"]));
    expect((await websiteTracking.numberFor(db(), { ...q, visitorId: visitor }, meta)).number).toBe(mine.number);
    const theirs = await websiteTracking.numberFor(db(), { companyKey: SLUG, visitorId: other, query: "utm_source=facebook" }, meta);
    expect(theirs.pooled).toBe(true);
    expect(theirs.number).not.toBe(mine.number);
  });

  it("falls back to the static number for the visitor's source when the pool is empty, else the main number", async () => {
    const google = await websiteTracking.numberFor(db(), { companyKey: SLUG, visitorId: third, query: "gclid=X" }, meta);
    expect(google).toMatchObject({ pooled: false, number: "+15125557100" });
    const direct = await websiteTracking.numberFor(db(), { companyKey: SLUG, visitorId: `${third}x` }, meta);
    expect(direct).toMatchObject({ pooled: false, number: MAIN });
  });

  it("credits a call on the pool number with the visit's tags and click id, and stitches the visit to the caller", async () => {
    const mine = await websiteTracking.numberFor(db(), { companyKey: SLUG, visitorId: visitor }, meta);
    const SID = `CA${randomBytes(8).toString("hex")}`;
    await webhook("incoming", { CallSid: SID, From: "+15125557060", To: mine.number! });
    const [touch] = await raw<{ source: string; click_id: string; visitor_id: string; basis: string }[]>`
      select t.source, t.click_id, t.visitor_id, t.basis from public.marketing_touch t
      join public.call c on c.id = t.call_id where c.provider_call_id = ${`twilio:${SID}`}`;
    expect(touch).toEqual({ source: "google_ads", click_id: "GCLID-1", visitor_id: visitor, basis: "utm" });

    const customer = await customers.create(owner(), {
      type: "residential", name: "Pool Caller", phone: "(512) 555-7060",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const touches = await raw<{ customer_id: string }[]>`
      select customer_id from public.marketing_touch where organization_id = ${ORG} and visitor_id = ${visitor}`;
    expect(touches.length).toBeGreaterThanOrEqual(2);
    expect(touches.every((t) => t.customer_id === customer.id)).toBe(true);
  });

  it("gives a quiet visitor's number back, stamped when it lapsed", async () => {
    await raw`update public.dni_session set last_seen_at = now() - interval '2 hours'
              where organization_id = ${ORG} and visitor_id = ${other}`;
    expect(await websiteTracking.releaseIdle(db(), ORG)).toBe(1);
    const [lease] = await raw<{ gap: number }[]>`
      select extract(epoch from released_at - last_seen_at)::int as gap from public.dni_session
      where organization_id = ${ORG} and visitor_id = ${other}`;
    expect(lease!.gap).toBe(30 * 60);
  });

  it("refuses a visitor who knocks too often, and a company nobody holds", async () => {
    const noisy = randomBytes(16).toString("hex");
    for (let i = 0; i < 10; i += 1) {
      await websiteTracking.recordVisit(db(), { companyKey: SLUG, visitorId: noisy, page: "/" }, { ip: `${ip}9` });
    }
    await expect(websiteTracking.recordVisit(db(), { companyKey: SLUG, visitorId: noisy, page: "/" }, { ip: `${ip}9` }))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(websiteTracking.recordVisit(db(), { companyKey: "nobody-holds-this", visitorId: noisy }, meta))
      .rejects.toThrow(/not found/);
    await expect(websiteTracking.recordVisit(db(), { companyKey: SLUG, visitorId: "me@example.com" }, meta))
      .rejects.toThrow(/visitor id/);
  });
});

run("handing a number back", () => {
  it("releases it at Twilio and then here, and answers a second release as the first", async () => {
    const [number] = await raw<{ id: string; provider_number_id: string }[]>`
      select id, provider_number_id from public.phone_number where organization_id = ${ORG} and e164 = '+15125557202'`;
    asked.length = 0;
    const released = await voice.releaseNumber(owner(), { id: number!.id }, deps);
    expect(released.released).toBe(true);
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      `DELETE https://api.twilio.com/2010-04-01/Accounts/ACtest/IncomingPhoneNumbers/${number!.provider_number_id}.json`,
    ]);
    expect((await voice.releaseNumber(owner(), { id: number!.id }, deps)).released).toBe(true);
    expect(asked).toHaveLength(1);
  });
});
