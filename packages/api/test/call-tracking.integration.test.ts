import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { createHmac } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as callTracking from "../src/services/call-tracking";
import * as customers from "../src/services/customers";
import {
  callRailProvider, verifyCallRailWebhook, callRailSignature,
  SIGNATURE_HEADER, MAX_SKEW_MS,
} from "../src/call-tracking/callrail";
import type {
  CallFetch, CallTrackingProvider, CredentialCheck, TrackedCall, WebhookRequest,
} from "../src/call-tracking/provider";
import "../src/call-tracking/index";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A TRACKED CALL IS A NUMBER AN OWNER MOVES A BUDGET WITH
 *
 * For most trades companies this is the only measurement their marketing
 * gets. A yard sign, a van, a mailer and a radio spot carry no query string,
 * so the number on them is the tag, and a call on that number is the entire
 * evidence that the spend did anything.
 *
 * Which makes the two failures here expensive in opposite directions. A
 * forged call inflates a channel somebody then puts more money behind. A
 * duplicated call does the same thing more quietly, because every figure
 * downstream is plausible and simply too high.
 *
 * NO TEST IN THIS FILE REACHES CALLRAIL. The transport is injected, which is
 * the point of the seam: a test that monkey patched `fetch` would pass
 * against a provider whose shape had drifted.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("calltracking:org");
const USER = fixtureId("calltracking:user");
const KEY_REF = "TEST_CALLRAIL_KEY";
const SECRET_REF = "TEST_CALLRAIL_SIGNING";
const SIGNING_KEY = "a-callrail-signing-key-for-the-tests";

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles },
  db: db(),
});

const deps = (provider?: CallTrackingProvider): callTracking.CallTrackingDeps => ({
  readSecret: async (ref) => (ref === SECRET_REF ? SIGNING_KEY : "not-a-real-api-key"),
  ...(provider ? { provider } : {}),
});

/* ================================================= the published signature */

/**
 * CALLRAIL'S OWN WORKED EXAMPLE, COPIED EXACTLY.
 *
 * Their documentation publishes a body, a signing key and the signature they
 * expect from it, so this is not a test of our implementation against our own
 * understanding of their implementation: it is a test against the vendor's
 * stated answer. If we ever drift from it, this fails, which is worth far
 * more than a round trip through our own signer.
 */
const VECTOR_KEY = "072e77e426f92738a72fe23c4d1953b4";
const VECTOR_SIGNATURE = "UZAHbUdfm3GqL7qzilGozGzWV64=";
const VECTOR_BODY =
  "{\"answered\":false,\"business_phone_number\":\"\",\"call_type\":\"voicemail\",\"compa"
  + "ny_id\":155920786,\"company_name\":\"Boost Marketing\",\"company_time_zone\":\"America"
  + "/Los_Angeles\",\"created_at\":\"2018-02-19T13:41:00.252-05:00\",\"customer_city\":\"Ro"
  + "chester\",\"customer_country\":\"US\",\"customer_name\":\"Kaylah Mills\",\"customer_ph"
  + "one_number\":\"+12148654559\",\"customer_state\":\"PA\",\"device_type\":\"\",\"directi"
  + "on\":\"inbound\",\"duration\":\"13\",\"first_call\":false,\"formatted_call_type\":\"Vo"
  + "icemail\",\"formatted_customer_location\":\"Rochester, PA\",\"formatted_business_phone"
  + "_number\":\"\",\"formatted_customer_name\":\"Kaylah Mills\",\"prior_calls\":16,\"forma"
  + "tted_customer_name_or_phone_number\":\"Kaylah Mills\",\"formatted_customer_phone_numbe"
  + "r\":\"214-865-4559\",\"formatted_duration\":\"13s\",\"formatted_tracking_phone_number\""
  + ":\"404-555-8514\",\"formatted_tracking_source\":\"Google Paid\",\"formatted_value\":\""
  + "--\",\"good_lead_call_id\":715587840,\"good_lead_call_time\":\"2016-06-17T10:23:33.363"
  + "-04:00\",\"id\":766970532,\"lead_status\":\"previously_marked_good_lead\",\"note\":\"\""
  + ",\"recording\":\"https://app.callrail.com/calls/766970532/recording/redirect?access_ke"
  + "y=aaaaccccddddeeee\",\"recording_duration\":8,\"source_name\":\"Google AdWords\",\"sta"
  + "rt_time\":\"2018-02-19T13:41:00.236-05:00\",\"tags\":[],\"total_calls\":17,\"tracking_"
  + "phone_number\":\"+14045558514\",\"transcription\":\"\",\"value\":\"\",\"voicemail\":tr"
  + "ue,\"tracker_id\":354024023,\"keywords\":\"\",\"medium\":\"\",\"referring_url\":\"\",\""
  + "landing_page_url\":\"\",\"last_requested_url\":\"\",\"referrer_domain\":\"\",\"convers"
  + "ational_transcript\":\"\",\"utm_source\":\"google\",\"utm_medium\":\"cpc\",\"utm_term\""
  + ":\"\",\"utm_content\":\"\",\"utm_campaign\":\"Google AdWords\",\"utma\":\"\",\"utmb\":"
  + "\"\",\"utmc\":\"\",\"utmv\":\"\",\"utmz\":\"\",\"ga\":\"\",\"gclid\":\"\",\"integratio"
  + "n_data\":[{\"integration\":\"Webhooks\",\"data\":null}],\"keywords_spotted\":\"\",\"re"
  + "cording_player\":\"https://app.callrail.com/calls/766970532/recording?access_key=aaaab"
  + "bbbccccdddd\",\"speaker_percent\":\"\",\"call_highlights\":[],\"callercity\":\"Rochest"
  + "er\",\"callercountry\":\"US\",\"callername\":\"Kaylah Mills\",\"callernum\":\"+1214865"
  + "4559\",\"callerstate\":\"PA\",\"callsource\":\"google_paid\",\"campaign\":\"\",\"custo"
  + "m\":\"\",\"datetime\":\"2018-02-19 18:41:00\",\"destinationnum\":\"\",\"ip\":\"\",\"ki"
  + "ssmetrics_id\":\"\",\"landingpage\":\"\",\"referrer\":\"\",\"referrermedium\":\"\",\"s"
  + "core\":1,\"tag\":\"\",\"trackingnum\":\"+14045558514\",\"timestamp\":\"2018-02-19T13:4"
  + "1:00.236-05:00\"}";

describe("the CallRail signature", () => {
  it("reproduces the signature their documentation publishes", () => {
    expect(callRailSignature(VECTOR_KEY, VECTOR_BODY)).toBe(VECTOR_SIGNATURE);
  });

  it("is HMAC-SHA1 over the raw body, base64, which is what they offer", () => {
    /**
     * Stated as its own assertion because it is the fact most likely to be
     * assumed wrong. Every other webhook in this codebase is SHA-256, and a
     * reader who assumed this one was too would write a verifier that
     * refuses every genuine delivery.
     */
    expect(VECTOR_SIGNATURE).toBe(
      createHmac("sha1", VECTOR_KEY).update(Buffer.from(VECTOR_BODY, "utf8")).digest("base64"),
    );
  });

  const signed = (over: { body?: string; key?: string; at?: number } = {}): WebhookRequest => {
    const at = over.at ?? Date.parse("2026-04-01T12:00:00Z");
    const body = over.body ?? JSON.stringify({
      id: "CAL1", tracking_phone_number: "+15125550100",
      customer_phone_number: "+15125550123", start_time: "2026-04-01T06:55:00.000-05:00",
      direction: "inbound", answered: true, duration: 120,
      timestamp: new Date(at).toISOString(),
    });
    return {
      body,
      headers: { [SIGNATURE_HEADER]: callRailSignature(over.key ?? SIGNING_KEY, body) },
    };
  };

  const NOW = () => Date.parse("2026-04-01T12:00:00Z");

  it("accepts a correctly signed delivery", () => {
    expect(verifyCallRailWebhook(signed(), SIGNING_KEY, NOW)).toBe(true);
  });

  it("refuses one signed with a different key", () => {
    expect(verifyCallRailWebhook(signed({ key: "someone-elses-key" }), SIGNING_KEY, NOW)).toBe(false);
  });

  it("refuses a body that changed after it was signed", () => {
    /**
     * The signature covers the RAW body, which is what catches a replay with
     * the campaign edited, and is also why nothing between the socket and
     * this check may reparse it: a JSON round trip moves one byte of
     * whitespace and every genuine delivery starts failing.
     */
    const request = signed();
    expect(verifyCallRailWebhook(
      { ...request, body: `${request.body} ` }, SIGNING_KEY, NOW,
    )).toBe(false);
  });

  it("refuses a delivery with no signature header at all", () => {
    expect(verifyCallRailWebhook({ body: signed().body, headers: {} }, SIGNING_KEY, NOW)).toBe(false);
  });

  it("refuses a replay once the window has passed", () => {
    /**
     * Without the window a captured delivery verifies forever, and every
     * replay of it is another call on the report. The timestamp is INSIDE
     * the signed body, which is the only place it can be: the body is all
     * that is signed, so a timestamp in a header would be free to change.
     */
    const old = signed({ at: NOW() - MAX_SKEW_MS - 60_000 });
    expect(verifyCallRailWebhook(old, SIGNING_KEY, NOW)).toBe(false);
  });

  it("accepts a delivery inside the window", () => {
    expect(verifyCallRailWebhook(signed({ at: NOW() - 60_000 }), SIGNING_KEY, NOW)).toBe(true);
  });

  it("accepts a signed delivery that carries no timestamp", () => {
    /**
     * A decision rather than an oversight, and the comment on it says why:
     * the window is a second line of defence behind a secret the attacker
     * does not have, and refusing every shape that omits the field would
     * turn one undocumented payload into silence. Silence here is lost
     * calls, because CallRail does not resend.
     */
    const body = JSON.stringify({ id: "CAL2", tracking_phone_number: "+1512" });
    expect(verifyCallRailWebhook(
      { body, headers: { [SIGNATURE_HEADER]: callRailSignature(SIGNING_KEY, body) } },
      SIGNING_KEY, NOW,
    )).toBe(true);
  });
});

/* ========================================================= parsing a call */

describe("reading what they sent", () => {
  const provider = () => callRailProvider({ accountId: "ACC1" }, "key");
  const parse = (payload: Record<string, unknown>) =>
    provider().parseCall({ body: JSON.stringify(payload), headers: {} });

  const base = {
    id: "CAL8154748ae6bd4e278a7cddd38a662f4f",
    tracking_phone_number: "+15125550100",
    customer_phone_number: "+15125550123",
    start_time: "2026-04-01T06:55:00.000-05:00",
    direction: "inbound",
    answered: true,
    duration: 120,
  };

  it("reads their worked example of a post-call body", () => {
    const call = provider().parseCall({ body: VECTOR_BODY, headers: {} });
    expect(call).not.toBeNull();
    expect(call!.trackingNumber).toBe("+14045558514");
    expect(call!.customerNumber).toBe("+12148654559");
    expect(call!.voicemail).toBe(true);
    expect(call!.answered).toBe(false);
    expect(call!.utm.source).toBe("google");
  });

  it("prefers the masked resource id over the legacy numeric one", () => {
    /**
     * Their v3 endpoints return `CAL8154...` and the worked example of a
     * webhook in their own documentation carries a bare number. Taking
     * whichever turned up would give one call two identities depending on
     * how it arrived, and the backfill would duplicate everything the
     * webhook already delivered.
     */
    const call = parse({ ...base, resource_id: "CALmasked", id: 766970532 });
    expect(call!.externalId).toBe("CALmasked");
  });

  it("falls back to the numeric id when that is all there is", () => {
    const call = parse({ ...base, id: 766970532 });
    expect(call!.externalId).toBe("766970532");
  });

  it("refuses a body with no tracking number, because nothing can attribute it", () => {
    expect(parse({ ...base, tracking_phone_number: undefined })).toBeNull();
  });

  it("refuses a body with no id of their own, which nothing could make idempotent", () => {
    /**
     * Without one, every such call would be stored under the same empty
     * provider id. The unique index would then read the second as a repeat
     * of the first, and a whole day of calls would collapse into one row
     * that keeps being rewritten: a silent loss rather than a duplicate,
     * which is the harder of the two to notice.
     */
    expect(parse({ ...base, id: undefined })).toBeNull();
  });

  it("refuses a body with no start time, because nothing can place it in a report", () => {
    expect(parse({ ...base, start_time: undefined, created_at: undefined })).toBeNull();
  });

  it("refuses the sibling webhooks CallRail posts at the same URL", () => {
    /**
     * A text message and a form submission are real CallRail webhooks and
     * neither is a call. Both are written here in the shape their own
     * documentation publishes, rather than as something convenient: a text
     * carries `source_number`, `destination_number` and `content`, and a
     * form carries `form_data` and `submitted_at`. Neither has a tracking
     * number, a caller's number and a start time, which is what refuses
     * them. Half-parsing either would put a phantom call on the record with
     * a marketing touch behind it, and a channel's lead count would climb
     * every time somebody filled in a form.
     */
    expect(parse({
      id: 879204976,
      resource_id: "SCI0c14896tw1b64fb970ab62aaf4fbefd9",
      source_number: "770-555-5555",
      destination_number: "770-123-4567",
      content: "Is someone free on Thursday",
      message_type: "sms",
      timestamp: "2017-10-23T15:57:18.826-04:00",
    })).toBeNull();

    expect(parse({
      id: 123456789,
      company_id: 987654321,
      form_data: { form_field1: "this is the message" },
      form_url: "http://www.example.com/form",
      submitted_at: "2017-10-24T09:40:18.000-04:00",
      first_form: true,
      source: "Google Organic",
    })).toBeNull();
  });

  it("refuses a body with no caller number, which nothing can match", () => {
    expect(parse({ ...base, customer_phone_number: undefined })).toBeNull();
  });

  it("does not treat a missing answered flag as answered", () => {
    /**
     * A pre-call webhook fires before anybody picks up and carries no such
     * field. Reading its absence as answered makes every missed call look
     * handled, which is the one number a shop manages to.
     */
    const call = parse({ ...base, answered: undefined });
    expect(call!.answered).toBe(false);
  });

  it("keeps their timezone offset rather than reading the clock as local", () => {
    const call = parse(base);
    expect(call!.startedAt.toISOString()).toBe("2026-04-01T11:55:00.000Z");
  });

  it("keeps the whole body, because a field map is always wrong about something", () => {
    const call = parse({ ...base, note: "Asked about the warranty" });
    expect(call!.raw["note"]).toBe("Asked about the warranty");
  });
});

/* ===================================================== recording the call */

const ADDRESS_FREE_CALL = (over: Partial<TrackedCall> = {}): TrackedCall => ({
  externalId: "CAL-one",
  direction: "inbound",
  trackingNumber: "+15125550100",
  customerNumber: "+15125550123",
  businessNumber: null,
  startedAt: new Date("2026-04-01T15:00:00.000Z"),
  durationSeconds: 184,
  answered: true,
  voicemail: false,
  customerName: "Priya Raman",
  utm: {},
  clickId: null,
  referrer: null,
  landingPath: null,
  personId: null,
  firstCall: true,
  raw: { id: "CAL-one" },
  ...over,
});

async function connected(settings: Record<string, unknown> = {}): Promise<string> {
  const connection = await callTracking.connect(ctx(), { accountId: "ACC1234", ...settings });
  await raw`update public.integration_connection
     set credential_ref = ${KEY_REF},
         settings = settings || ${raw.json({ webhookSecretRef: SECRET_REF } as never)}
   where id = ${connection.id}`;
  return connection.id;
}

const tokenOf = (path: string) => path.replace("/api/webhooks/call-tracking/", "");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tracking Co", slug: "tracking-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tracking Co", slug: "tracking-co" });
});

run("connecting", () => {
  it("hands over a webhook URL and the names of the two secrets", async () => {
    const connection = await callTracking.connect(ctx(), { accountId: "ACC1234" });
    expect(connection.webhookPath).toMatch(/^\/api\/webhooks\/call-tracking\/[A-Za-z0-9_-]{40,}$/);
    expect(connection.apiKeyRef).toContain("OTOS_CALL_TRACKING_KEY_");
    expect(connection.signingSecretRef).toContain("OTOS_CALL_TRACKING_SECRET_");
  });

  it("keeps the webhook URL when the same account is connected again", async () => {
    /**
     * Minting a new token on a reconnect would leave CallRail posting at a
     * dead URL, and because they do not resend, the first evidence would be
     * calls that never arrived and cannot be recovered except by a backfill
     * nobody knew to run.
     */
    const first = await callTracking.connect(ctx(), { accountId: "ACC1234" });
    const again = await callTracking.connect(ctx(), { accountId: "ACC1234" });
    expect(again.webhookPath).toBe(first.webhookPath);
  });

  it("refuses an account id that is not one", async () => {
    await expect(callTracking.connect(ctx(), { accountId: "no" })).rejects.toThrow(/account id/i);
  });

  it("refuses to connect at all without the integration permission", async () => {
    await expect(callTracking.connect(ctx(["dispatcher"]), { accountId: "ACC1234" }))
      .rejects.toThrow(/permission|integration:write/i);
  });

  it("refuses somebody who may only LOOK at integrations", async () => {
    /**
     * The read permission and the write one are different questions and this
     * pins which is being asked. Connecting stores a webhook URL, derives
     * two credential names and puts this company's call data on a path an
     * outside vendor posts to, and somebody who may see which integrations
     * exist has not been given that. No stock role holds the read without
     * the write, so the actor is built with the grant directly, which is how
     * a connected application's authority arrives in any case.
     */
    const viewer: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: [], grants: ["integration:read"] },
      db: db(),
    };
    await expect(callTracking.connect(viewer, { accountId: "ACC1234" }))
      .rejects.toThrow(/permission|integration:write/i);
  });
});

run("resolving a delivery to a tenant", () => {
  it("finds the connection behind the token", async () => {
    const connection = await callTracking.connect(ctx(), { accountId: "ACC1234" });
    await raw`update public.integration_connection
       set credential_ref = ${KEY_REF},
           settings = settings || ${raw.json({ webhookSecretRef: SECRET_REF } as never)}
     where id = ${connection.id}`;

    const resolved = await callTracking.resolveWebhook(
      db(), tokenOf(connection.webhookPath!), deps(),
    );
    expect(resolved!.organizationId).toBe(ORG);
    expect(resolved!.secret).toBe(SIGNING_KEY);
  });

  it("finds nothing for a token nobody minted", async () => {
    expect(await callTracking.resolveWebhook(db(), "x".repeat(40), deps())).toBeNull();
  });

  it("refuses a token short enough to guess rather than looking it up", async () => {
    /**
     * A deployment that hand-edits a weak token gets an endpoint that
     * receives nothing, rather than an endpoint anybody can post to.
     */
    const connection = await callTracking.connect(ctx(), { accountId: "ACC1234" });
    await raw`update public.integration_connection
       set settings = settings || ${raw.json({ webhookToken: "short" } as never)}
     where id = ${connection.id}`;
    expect(await callTracking.resolveWebhook(db(), "short", deps())).toBeNull();
  });
});

run("what a delivery does", () => {
  const webhook = (call: Partial<TrackedCall> = {}, over: { at?: number } = {}) => {
    const payload = {
      resource_id: call.externalId ?? "CAL-one",
      tracking_phone_number: call.trackingNumber ?? "+15125550100",
      customer_phone_number: call.customerNumber ?? "+15125550123",
      customer_name: "Priya Raman",
      start_time: (call.startedAt ?? new Date("2026-04-01T15:00:00.000Z")).toISOString(),
      direction: call.direction ?? "inbound",
      answered: call.answered ?? true,
      duration: call.durationSeconds ?? 184,
      voicemail: call.voicemail ?? false,
      recording: "https://app.callrail.com/calls/1/recording?access_key=secret",
      transcription: "My card number is 4111 1111 1111 1111",
      utm_source: call.utm?.source,
      utm_medium: call.utm?.medium,
      utm_campaign: call.utm?.campaign,
      gclid: call.clickId,
      person_id: call.personId,
      timestamp: new Date(over.at ?? Date.parse("2026-04-01T15:01:00.000Z")).toISOString(),
    };
    const body = JSON.stringify(payload);
    return {
      body,
      headers: { [SIGNATURE_HEADER]: callRailSignature(SIGNING_KEY, body) },
    };
  };

  const connectionFor = async () => {
    const id = await connected();
    const [row] = await raw<{ settings: { webhookToken: string } }[]>`
      select settings from public.integration_connection where id = ${id}`;
    return callTracking.resolveWebhook(db(), row!.settings.webhookToken, deps());
  };

  const AT = new Date("2026-04-01T15:01:00.000Z");

  it("refuses a delivery with a forged signature and records nothing", async () => {
    const connection = await connectionFor();
    const request = webhook();
    const outcome = await callTracking.receive(
      db(), connection!, { ...request, headers: { [SIGNATURE_HEADER]: "ZmFrZQ==" } }, AT,
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "bad_signature" });

    const [count] = await raw<{ n: string }[]>`select count(*)::text as n from public.call where organization_id = ${ORG}`;
    expect(count!.n).toBe("0");
  });

  it("records a call and a marketing touch", async () => {
    const connection = await connectionFor();
    const outcome = await callTracking.receive(db(), connection!, webhook(), AT);
    expect(outcome.kind).toBe("recorded");

    const [call] = await raw<{
      direction: string; from_e164: string; to_e164: string; received_on_e164: string;
      status: string; duration_seconds: number; provider_call_id: string;
    }[]>`select direction, from_e164, to_e164, received_on_e164, status, duration_seconds, provider_call_id
         from public.call where organization_id = ${ORG}`;
    expect(call!.direction).toBe("inbound");
    expect(call!.from_e164).toBe("+15125550123");
    expect(call!.received_on_e164).toBe("+15125550100");
    expect(call!.status).toBe("completed");
    expect(call!.duration_seconds).toBe(184);
    expect(call!.provider_call_id).toBe("callrail:CAL-one");

    const [touch] = await raw<{ source: string; basis: string; tracked_number_e164: string }[]>`
      select source, basis, tracked_number_e164 from public.marketing_touch where organization_id = ${ORG}`;
    expect(touch!.tracked_number_e164).toBe("+15125550100");
  });

  it("does not store the recording link anywhere anything plays it from", async () => {
    /**
     * `telephony.attachRecording` refuses a recording for a call that was
     * never granted permission under this company's own declared policy, and
     * a webhook carries no evidence that anybody decided anything. Writing
     * the URL from here would walk straight past the gate that file exists
     * to be.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);

    const [call] = await raw<{ recording_url: string | null; recording_started_at: Date | null }[]>`
      select recording_url, recording_started_at from public.call where organization_id = ${ORG}`;
    expect(call!.recording_url).toBeNull();
    expect(call!.recording_started_at).toBeNull();
  });

  it("does not store the transcript, which would arrive unredacted", async () => {
    /**
     * `telephony.attachTranscript` removes card numbers in the same
     * statement that stores the text, so there is no window in which the raw
     * version is in the table. A transcript written in from here would be
     * the raw version, in the table, in the backups.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);

    const [call] = await raw<{ transcript: string | null }[]>`
      select transcript from public.call where organization_id = ${ORG}`;
    expect(call!.transcript).toBeNull();
  });

  it("keeps the transcript out of the payload it stores as well", async () => {
    /**
     * The obvious way around the refusal above. A transcript kept inside the
     * raw body is the same unredacted text in the same database, with
     * somebody's spoken card number in it, and the only difference is which
     * column an export happens to read.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);

    const [call] = await raw<{ source_payload: Record<string, unknown> }[]>`
      select source_payload from public.call where organization_id = ${ORG}`;
    expect(JSON.stringify(call!.source_payload)).not.toContain("4111");
    expect(call!.source_payload["transcription"]).toBeUndefined();
  });

  it("keeps the recording link out of the payload it stores", async () => {
    /**
     * Their player link carries its own access key in the query string,
     * which makes it the audio rather than a pointer to the audio: anybody
     * who can read the row could play a recording nobody decided could be
     * kept.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);

    const [call] = await raw<{ source_payload: Record<string, unknown> }[]>`
      select source_payload from public.call where organization_id = ${ORG}`;
    expect(JSON.stringify(call!.source_payload)).not.toContain("access_key");
  });

  it("names what it dropped, rather than leaving a silence", async () => {
    /**
     * Without this the row is indistinguishable from one where the provider
     * sent nothing, and somebody debugging a missing recording spends an
     * afternoon on the provider's side of a decision made here.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);

    const [call] = await raw<{ source_payload: { _not_stored?: string[] } }[]>`
      select source_payload from public.call where organization_id = ${ORG}`;
    expect(call!.source_payload._not_stored).toContain("recording");
    expect(call!.source_payload._not_stored).toContain("transcription");
  });

  it("still keeps everything the call was attributed to", async () => {
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook({
      utm: { source: "google", medium: "cpc", campaign: "AC Repair" },
    }), AT);

    const [call] = await raw<{ source_payload: Record<string, unknown> }[]>`
      select source_payload from public.call where organization_id = ${ORG}`;
    expect(call!.source_payload["utm_campaign"]).toBe("AC Repair");
    expect(call!.source_payload["customer_name"]).toBe("Priya Raman");
  });

  it("records one call and one touch when the same delivery arrives twice", async () => {
    /**
     * The ordinary case rather than an attack: CallRail sends a pre-call, a
     * post-call and a modified webhook about one call, and a backfill
     * replays whatever landed. A second touch here is a second lead on the
     * report for one phone call.
     */
    const connection = await connectionFor();
    const first = await callTracking.receive(db(), connection!, webhook(), AT);
    const second = await callTracking.receive(db(), connection!, webhook(), AT);

    expect(first.kind === "recorded" && first.duplicate).toBe(false);
    expect(second.kind === "recorded" && second.duplicate).toBe(true);

    const [calls] = await raw<{ n: string }[]>`select count(*)::text as n from public.call where organization_id = ${ORG}`;
    const [touches] = await raw<{ n: string }[]>`select count(*)::text as n from public.marketing_touch where organization_id = ${ORG}`;
    expect(calls!.n).toBe("1");
    expect(touches!.n).toBe("1");
  });

  it("recognises the same call arriving under their other id format", async () => {
    /**
     * THE SECOND IDEMPOTENCY GUARD. Their v3 endpoints return a masked id
     * and their documented webhook example carries a numeric one. If a
     * deployment is sent one by webhook and the other by backfill, the index
     * on the provider id would let the same call in twice, each row right,
     * and every count of calls quietly too high.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);
    await callTracking.receive(
      db(), connection!, webhook({ externalId: "766970532" }), AT,
    );

    const [calls] = await raw<{ n: string }[]>`select count(*)::text as n from public.call where organization_id = ${ORG}`;
    expect(calls!.n).toBe("1");
  });

  it("recognises a repeat whose start time moved, through the index on their id", async () => {
    /**
     * THE FIRST IDEMPOTENCY GUARD, ON ITS OWN. The natural key cannot help
     * here because the second delivery disagrees about when the call began,
     * which is what a corrected or modified delivery does. Without the
     * unique index on their id this is two calls, each plausible, and the
     * call count for the month is wrong by however many calls were restated.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);
    const second = await callTracking.receive(db(), connection!, webhook({
      startedAt: new Date("2026-04-01T15:30:00.000Z"),
    }), AT);

    expect(second.kind === "recorded" && second.duplicate).toBe(true);
    const [calls] = await raw<{ n: string }[]>`select count(*)::text as n from public.call where organization_id = ${ORG}`;
    const [touches] = await raw<{ n: string }[]>`select count(*)::text as n from public.marketing_touch where organization_id = ${ORG}`;
    expect(calls!.n).toBe("1");
    expect(touches!.n).toBe("1");
  });

  it("takes the later delivery's duration and outcome over the earlier one's", async () => {
    /**
     * A pre-call webhook fires before anybody picks up and carries neither.
     * Keeping only the first version leaves every call in the system at zero
     * seconds and unanswered.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook({
      answered: false, durationSeconds: 0,
    }), AT);
    await callTracking.receive(db(), connection!, webhook({
      answered: true, durationSeconds: 184,
    }), AT);

    const [call] = await raw<{ status: string; duration_seconds: number }[]>`
      select status, duration_seconds from public.call where organization_id = ${ORG}`;
    expect(call!.status).toBe("completed");
    expect(call!.duration_seconds).toBe(184);
  });

  it("records no marketing touch for an outbound call", async () => {
    /**
     * An outbound call is the company ringing the customer. Counting it as a
     * touch credits the channel on whichever number the office dialled from.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook({ direction: "outbound" }), AT);

    const [touches] = await raw<{ n: string }[]>`select count(*)::text as n from public.marketing_touch where organization_id = ${ORG}`;
    expect(touches!.n).toBe("0");
  });

  it("resolves the source through the number map the operator declared", async () => {
    const connection = await connectionFor();
    await raw`insert into public.phone_number (organization_id, e164, purpose, attribution_source)
      values (${ORG}, '+15125550100', 'tracking', 'yard_sign')`;

    await callTracking.receive(db(), connection!, webhook(), AT);

    const [touch] = await raw<{ source: string; basis: string }[]>`
      select source, basis from public.marketing_touch where organization_id = ${ORG}`;
    expect(touch!.source).toBe("yard_sign");
    expect(touch!.basis).toBe("tracked_number");
  });

  it("lets their utm pair beat the number, the way a tagged visit does", async () => {
    /**
     * The same ladder of evidence a website visit goes through, rather than
     * a second opinion written here. A utm somebody set on purpose beats an
     * inference from the number they happened to dial.
     */
    const connection = await connectionFor();
    await raw`insert into public.phone_number (organization_id, e164, purpose, attribution_source)
      values (${ORG}, '+15125550100', 'tracking', 'yard_sign')`;

    await callTracking.receive(db(), connection!, webhook({
      utm: { source: "google", medium: "cpc", campaign: "AC Repair" },
    }), AT);

    const [touch] = await raw<{ source: string; basis: string; utm_campaign: string }[]>`
      select source, basis, utm_campaign from public.marketing_touch where organization_id = ${ORG}`;
    expect(touch!.source).toBe("google_ads");
    expect(touch!.basis).toBe("utm");
    expect(touch!.utm_campaign).toBe("AC Repair");
  });

  it("keeps an unrecognised source verbatim rather than calling it direct", async () => {
    /**
     * A touch this could not place is `unknown` and the original string is
     * kept, because every row with something there is real money going into
     * a campaign no report can group. Folding it into `direct` makes a data
     * problem look like brand strength.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook({
      utm: { source: "the-radio-guy", medium: "spot" },
    }), AT);

    const [touch] = await raw<{ source: string; unrecognised: string }[]>`
      select source, unrecognised from public.marketing_touch where organization_id = ${ORG}`;
    expect(touch!.source).toBe("unknown");
    expect(touch!.unrecognised).toBe("the-radio-guy");
  });

  it("attaches the call to a customer already holding that number", async () => {
    const connection = await connectionFor();
    const customer = await customers.create(ctx(), {
      type: "residential", name: "Priya Raman", phone: "+15125550123",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });

    await callTracking.receive(db(), connection!, webhook(), AT);

    const [call] = await raw<{ customer_id: string }[]>`
      select customer_id from public.call where organization_id = ${ORG}`;
    expect(call!.customer_id).toBe(customer.id);
  });

  it("creates no customer from a call, because a wrong number is not a lead", async () => {
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook(), AT);

    const [count] = await raw<{ n: string }[]>`select count(*)::text as n from public.customer where organization_id = ${ORG}`;
    expect(count!.n).toBe("0");
  });

  it("stitches the calls somebody made before they were a customer", async () => {
    /**
     * Somebody rings three times before booking. Without the stitch the
     * first two belong to nobody and the third belongs to the customer,
     * which is last touch attribution by accident rather than by choice.
     */
    const connection = await connectionFor();
    await callTracking.receive(db(), connection!, webhook({
      externalId: "CAL-early", personId: "PER1",
      startedAt: new Date("2026-03-20T15:00:00.000Z"),
    }), AT);

    const customer = await customers.create(ctx(), {
      type: "residential", name: "Priya Raman", phone: "+15125550123",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });

    await callTracking.receive(db(), connection!, webhook({
      externalId: "CAL-later", personId: "PER1",
    }), AT);

    const stitched = await raw<{ n: string }[]>`
      select count(*)::text as n from public.marketing_touch
      where organization_id = ${ORG} and customer_id = ${customer.id}`;
    expect(stitched[0]!.n).toBe("2");
  });
});

/* ============================================================== backfill */

run("the backfill, which is the remedy for a delivery they never resend", () => {
  const fake = (pages: TrackedCall[][], over: Partial<CallTrackingProvider> = {}): CallTrackingProvider => ({
    name: "callrail",
    proof: { kind: "signature", header: SIGNATURE_HEADER, secretIs: "test", verify: () => true },
    parseCall: () => null,
    async listCalls({ page }): Promise<CallFetch> {
      const calls = pages[page - 1] ?? [];
      return { ok: true, calls, page, hasMore: page < pages.length };
    },
    async checkCredential(): Promise<CredentialCheck> {
      return { ok: true, accountId: "ACC1234", accountName: "Tracking Co" };
    },
    ...over,
  });

  const window = { since: "2026-04-01T00:00:00.000Z", until: "2026-04-02T00:00:00.000Z" };

  it("walks every page and imports what it finds", async () => {
    await connected();
    const provider = fake([
      [ADDRESS_FREE_CALL({ externalId: "CAL-1" }), ADDRESS_FREE_CALL({ externalId: "CAL-2", startedAt: new Date("2026-04-01T16:00:00.000Z") })],
      [ADDRESS_FREE_CALL({ externalId: "CAL-3", startedAt: new Date("2026-04-01T17:00:00.000Z") })],
    ]);

    const result = await callTracking.backfill(ctx(), window, deps(provider));
    expect(result).toMatchObject({ imported: 3, duplicates: 0, pages: 2, stoppedBecause: null });
  });

  it("is a no-op over a window that already landed", async () => {
    await connected();
    const provider = fake([[ADDRESS_FREE_CALL({ externalId: "CAL-1" })]]);

    await callTracking.backfill(ctx(), window, deps(provider));
    const second = await callTracking.backfill(ctx(), window, deps(provider));

    expect(second).toMatchObject({ imported: 0, duplicates: 1 });
    const [calls] = await raw<{ n: string }[]>`select count(*)::text as n from public.call where organization_id = ${ORG}`;
    expect(calls!.n).toBe("1");
  });

  it("stops on a failed page and says why, rather than reporting a complete count", async () => {
    /**
     * Carrying on past a page that failed reports a number that looks
     * finished and is missing whatever that page held, which is the shape of
     * answer that stops anybody going back for it.
     */
    await connected();
    const provider = fake([[ADDRESS_FREE_CALL({ externalId: "CAL-1" })]], {
      async listCalls({ page }): Promise<CallFetch> {
        if (page === 1) {
          return { ok: true, calls: [ADDRESS_FREE_CALL({ externalId: "CAL-1" })], page, hasMore: true };
        }
        return { ok: false, code: "http_429", message: "Too many requests", retryable: true };
      },
    });

    const result = await callTracking.backfill(ctx(), window, deps(provider));
    expect(result.imported).toBe(1);
    expect(result.stoppedBecause).toContain("http_429");
  });

  it("leaves a sync run behind, so a backfill nobody ran looks different from one that did", async () => {
    await connected();
    const provider = fake([[ADDRESS_FREE_CALL({ externalId: "CAL-1" })]]);
    await callTracking.backfill(ctx(), window, deps(provider));

    const [row] = await raw<{ entity_type: string; records_written: number }[]>`
      select entity_type, records_written from public.sync_run where organization_id = ${ORG}`;
    expect(row!.entity_type).toBe("call");
    expect(row!.records_written).toBe(1);
  });

  it("refuses a window whose start is after its end", async () => {
    await connected();
    await expect(callTracking.backfill(
      ctx(), { since: window.until, until: window.since }, deps(fake([])),
    )).rejects.toThrow(/start before its end/i);
  });

  it("writes the credential check onto the connection, and clears a stale error", async () => {
    const id = await connected();
    await raw`update public.integration_connection set status = 'error', last_error = 'old news' where id = ${id}`;

    const outcome = await callTracking.check(ctx(), deps(fake([])));
    expect(outcome.ok).toBe(true);

    const [row] = await raw<{ status: string; last_error: string | null }[]>`
      select status, last_error from public.integration_connection where id = ${id}`;
    expect(row!.status).toBe("connected");
    expect(row!.last_error).toBeNull();
  });

  it("records why a credential check failed rather than only that it did", async () => {
    const id = await connected();
    const provider = fake([], {
      async checkCredential(): Promise<CredentialCheck> {
        return { ok: false, code: "http_401", message: "CallRail refused the API key.", retryable: false };
      },
    });

    const outcome = await callTracking.check(ctx(), deps(provider));
    expect(outcome.ok).toBe(false);

    const [row] = await raw<{ status: string; last_error: string }[]>`
      select status, last_error from public.integration_connection where id = ${id}`;
    expect(row!.status).toBe("error");
    expect(row!.last_error).toContain("http_401");
  });
});
