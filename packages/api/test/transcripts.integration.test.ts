import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as telephony from "../src/services/telephony";
import * as transcription from "../src/services/transcription";
import * as marketingReport from "../src/services/marketing-report";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import { createWhisperTranscription, segmentsFromWhisper } from "../src/voice/whisper";
import type { TranscriptionProvider } from "../src/voice/transcription";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A CALL'S AUDIO, WRITTEN OUT AND SEARCHABLE
 *
 * A caller agrees to be recorded, the recording arrives on the carrier's
 * signed webhook and is kept, and the worker writes it out through the
 * speech to text seam, here a fake. The words land redacted (the card number
 * the caller read out is gone before the write), are searchable on the call
 * log, and go when the recording is deleted. A call somebody refused to have
 * recorded never gets a transcript by another route.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("transcripts:org");
const USER = fixtureId("transcripts:user");
const AUTH = "a-twilio-auth-token-for-transcripts";
const TOKEN = "s".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const NUMBER = "+15125559000";
const OFFICE = "+15125559001";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 7, 7, 7]);

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  if (to.endsWith(".mp3")) return new Response(MP3, { status: 200 });
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const deps: voice.VoiceDeps = {
  readSecret: async () => AUTH, provider: createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport), publicBase: BASE,
};

/** What the fake speech to text was handed, and what it will say next. */
const heard: { bytes: number; speaker: string }[] = [];
let answer: Awaited<ReturnType<TranscriptionProvider["transcribe"]>> = { ok: true, segments: [], language: "en" };
const fake: TranscriptionProvider = {
  name: "fake",
  async transcribe(audio) {
    heard.push({ bytes: audio.bytes.length, speaker: audio.speaker });
    return answer;
  },
};

async function webhook(step: voice.Step, form: Record<string, string>) {
  const connection = (await voice.resolveWebhook(db(), TOKEN, deps))!;
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}`;
  return voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  }, deps);
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Transcripts Co", slug: "transcripts-co" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
            values (${ORG}, 'transcription', 'whisper', 'connected', ${raw.json({ endpoint: "http://whisper.office.local/v1" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, provider_number_id, forwards_to_e164, record_calls)
            values (${ORG}, ${NUMBER}, 'main', 'PNtranscripts', ${OFFICE}, true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

async function recordedCall(from: string): Promise<string> {
  const SID = `CA${randomBytes(8).toString("hex")}`;
  await webhook("incoming", { CallSid: SID, From: from, To: NUMBER });
  await webhook("connect", { CallSid: SID, Digits: "1" });
  await webhook("recording", {
    CallSid: SID, RecordingSid: `RE${SID}`, RecordingStatus: "completed",
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE${SID}`,
  });
  const [call] = await raw<{ id: string }[]>`select id from public.call where provider_call_id = ${`twilio:${SID}`}`;
  return call!.id;
}

run("a kept recording, written out", () => {
  let callId = "";

  it("puts a kept recording in line to be written out, and announces it was kept", async () => {
    callId = await recordedCall("+15125550301");
    const [call] = await raw<{ transcript_status: string; transcript_source: string }[]>`
      select transcript_status, transcript_source from public.call where id = ${callId}`;
    expect(call).toMatchObject({ transcript_status: "pending", transcript_source: "recording" });
    const kept = await raw`select 1 from public.domain_event where name = 'call.recorded' and entity_id = ${callId}`;
    expect(kept).toHaveLength(1);
  });

  it("writes the words through the redaction gate: the card number is gone before the write", async () => {
    answer = {
      ok: true, language: "en",
      segments: [
        { speaker: "call", startMs: 0, endMs: 3000, text: "My water heater is leaking in the garage.", confidence: 0.94 },
        { speaker: "call", startMs: 3000, endMs: 7000, text: "The card is 4111 1111 1111 1111.", confidence: 0.91 },
      ],
    };
    const pass = await transcription.transcribePending(db(), ORG, { provider: fake });
    expect(pass).toMatchObject({ done: 1, failed: 0 });
    expect(heard.at(-1)).toEqual({ bytes: MP3.length, speaker: "call" });

    const [call] = await raw<{ transcript_status: string; transcript_text: string; transcript: string }[]>`
      select transcript_status, transcript_text, transcript from public.call where id = ${callId}`;
    expect(call!.transcript_status).toBe("done");
    expect(call!.transcript_text).not.toContain("4111");
    expect(call!.transcript).not.toContain("4111");
    expect(call!.transcript_text).not.toMatch(/\[\d\d:\d\d\]/);
    const done = await raw`select 1 from public.domain_event where name = 'call.transcribed' and entity_id = ${callId}`;
    expect(done).toHaveLength(1);
  });

  it("finds the call on the call log by what was said, and shows the line that matched", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const log = await marketingReport.callLog(owner(), {
      from: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), to: today, q: "leaking water heater",
    });
    expect(log.map((c) => c.id)).toEqual([callId]);
    expect(log[0]!.transcriptMatch).toContain("water heater");
    const none = await marketingReport.callLog(owner(), {
      from: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), to: today, q: "furnace",
    });
    expect(none).toHaveLength(0);
    expect((await telephony.callsFor(owner(), { q: "garage" })).map((c) => c.id)).toContain(callId);
    expect((await telephony.callsFor(owner(), { q: "555 0301" })).map((c) => c.id)).toContain(callId);
  });

  it("shows the transcript on the call, with its times and what was taken out", async () => {
    const call = await marketingReport.getCall(owner(), { id: callId });
    expect(call.transcript[0]).toMatchObject({ at: "00:00", text: "My water heater is leaking in the garage." });
    expect(call.transcriptRedactions).toEqual({ card_number: 1 });
    expect(call.transcriptReliable).toBe(true);
  });

  it("deletes the words with the recording", async () => {
    await telephony.deleteRecording(owner(), callId, "The customer asked.");
    const [call] = await raw<{ transcript: string | null; transcript_text: string | null; transcript_status: string | null }[]>`
      select transcript, transcript_text, transcript_status from public.call where id = ${callId}`;
    expect(call).toEqual({ transcript: null, transcript_text: null, transcript_status: null });
    expect(await telephony.callsFor(owner(), { q: "garage" })).toHaveLength(0);
  });
});

run("when it cannot be written out", () => {
  it("tries again after a provider's bad minute, and writes down a refusal it will not get past", async () => {
    const callId = await recordedCall("+15125550302");
    answer = { ok: false, code: "503", retryable: true, message: "The speech to text server answered 503." };
    expect(await transcription.transcribePending(db(), ORG, { provider: fake })).toMatchObject({ retrying: 1 });
    const [waiting] = await raw<{ transcript_status: string }[]>`select transcript_status from public.call where id = ${callId}`;
    expect(waiting!.transcript_status).toBe("pending");

    answer = { ok: true, language: "en", segments: [{ speaker: "call", startMs: 5, endMs: 1, text: "Backwards", confidence: 0.9 }] };
    expect(await transcription.transcribePending(db(), ORG, { provider: fake })).toMatchObject({ failed: 1 });
    const [failed] = await raw<{ transcript_status: string; transcript_error: string }[]>`
      select transcript_status, transcript_error from public.call where id = ${callId}`;
    expect(failed!.transcript_status).toBe("failed");
    expect(failed!.transcript_error).toContain("refused rather than repaired");
  });

  it("writes it out again from the call screen once the provider is back", async () => {
    const [failed] = await raw<{ id: string }[]>`
      select id from public.call where organization_id = ${ORG} and transcript_status = 'failed' limit 1`;
    answer = { ok: true, language: "en", segments: [{ speaker: "call", startMs: 0, endMs: 900, text: "Fine now.", confidence: 0.9 }] };
    const now = await transcription.transcribeNow(owner(), failed!.id, { provider: fake });
    expect(now).toMatchObject({ status: "done", error: null });
  });

  it("never keeps a transcript of a call somebody asked not to be recorded", async () => {
    const [call] = await raw<{ id: string }[]>`
      insert into public.call (organization_id, direction, from_e164, to_e164, status, recording_refusal)
      values (${ORG}, 'inbound', '+15125550303', ${NUMBER}, 'completed', 'party_declined') returning id`;
    await expect(telephony.attachTranscript(owner(), {
      callId: call!.id, segments: [{ speaker: "a", startMs: 0, endMs: 10, text: "Hello", confidence: 0.9 }],
    })).rejects.toThrow(/asked not to be recorded/);
  });
});

run("the Whisper adapter", () => {
  it("sends the audio to the server it is pointed at and maps its segments, dropping silence", async () => {
    let sentTo = "";
    let auth: string | null = "unset";
    const whisper = createWhisperTranscription({ endpoint: "http://whisper.office.local/v1/" }, "", async (to, init) => {
      sentTo = to;
      auth = new Headers(init?.headers).get("authorization");
      return Response.json({
        language: "en",
        segments: [
          { start: 0, end: 1.2345, text: " Hello there. ", avg_logprob: -0.1, no_speech_prob: 0.01 },
          { start: 1.2345, end: 2.5, text: " Thank you for watching. ", avg_logprob: -1.4, no_speech_prob: 0.9 },
        ],
      });
    });
    const result = await whisper.transcribe({ bytes: MP3, contentType: "audio/mpeg", fileName: "v.mp3", speaker: "caller" });
    expect(sentTo).toBe("http://whisper.office.local/v1/audio/transcriptions");
    expect(auth).toBeNull();
    expect(result.ok && result.segments).toEqual([
      { speaker: "caller", startMs: 0, endMs: 1234, text: "Hello there.", confidence: Math.exp(-0.1) },
    ]);
  });

  it("leaves a confidence the model did not give absent, so the gate refuses it rather than guessing", () => {
    expect(segmentsFromWhisper({ segments: [{ start: 0, end: 1, text: "Hi" }] }, "x")[0]!.confidence).toBeNull();
  });

  it("calls a busy server's answer worth retrying and a refusal not", async () => {
    const busy = createWhisperTranscription({}, "key", async () => Response.json({}, { status: 503 }));
    expect(await busy.transcribe({ bytes: MP3, contentType: "audio/mpeg", fileName: "v.mp3", speaker: "x" }))
      .toMatchObject({ ok: false, retryable: true });
    const refused = createWhisperTranscription({}, "key", async () => Response.json({ error: { message: "Bad file" } }, { status: 400 }));
    expect(await refused.transcribe({ bytes: MP3, contentType: "audio/mpeg", fileName: "v.mp3", speaker: "x" }))
      .toMatchObject({ ok: false, retryable: false, message: "Bad file" });
  });
});
