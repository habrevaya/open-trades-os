import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as commsInbound from "../src/services/comms-inbound";
import * as comms from "../src/services/comms";
import { createTwilioProvider, twilioSignature } from "../src/comms/twilio";
import type { MediaResult, MessagingProvider } from "../src/comms/provider";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * PICTURES BY TEXT, BOTH WAYS
 *
 * A customer texts a photograph of the leak. The carrier's signed webhook
 * arrives, the picture is fetched with the account's credentials and kept as
 * a stored file, and the inbox shows it to somebody with no login at the
 * carrier. A video is named in the thread and not kept. The office answers
 * with a photograph of the part, which goes as a picture message the carrier
 * fetches from an unguessable address that answers for nothing else.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pictures:org");
const USER = fixtureId("pictures:user");
const AUTH = "a-twilio-auth-token-for-pictures";
const TOKEN = "p".repeat(20) + randomBytes(12).toString("hex");
const MAIN = "+15125557700";
const CUSTOMER = "+15125557701";
const HOOK = `https://ots.test/api/webhooks/messaging/${TOKEN}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 9, 9, 9]);

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

const fetched: string[] = [];
const twilio = createTwilioProvider({ accountSid: "ACtest" }, AUTH);
/** The real adapter's signature check and parsing, with the media fetch handed in. */
const provider: MessagingProvider = {
  ...twilio,
  async fetchMedia(media: string): Promise<MediaResult> {
    fetched.push(media);
    if (media.endsWith("/ME-photo")) return { ok: true, bytes: PNG, contentType: "image/png" };
    if (media.endsWith("/ME-video")) return { ok: true, bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), contentType: "video/mp4" };
    return { ok: false, code: "404", retryable: false, message: "Twilio answered 404 for the picture." };
  },
};

function inbound(form: Record<string, string>, forge = false) {
  return commsInbound.receive(db(), provider, {
    url: HOOK,
    body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, forge ? `${HOOK}x` : HOOK, form) },
  }, ORG);
}

const media = (sid: string) => `https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/${sid}/Media`;

let conversationId = "";

beforeAll(async () => {
  if (!url) return;
  process.env["PUBLIC_URL"] = "https://ots.test";
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pictures Co", slug: "pictures-co" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, ${MAIN}, 'main', true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a picture texted in", () => {
  it("refuses a picture message the carrier did not sign, and fetches nothing", async () => {
    const outcome = await inbound({
      MessageSid: "MM-forged", From: CUSTOMER, To: MAIN, Body: "", NumMedia: "1",
      MediaUrl0: `${media("MM-forged")}/ME-photo`, MediaContentType0: "image/png",
    }, true);
    expect(outcome).toEqual({ kind: "rejected", reason: "bad_signature" });
    expect(fetched).toHaveLength(0);
  });

  it("keeps the picture as a stored file, and names a video it does not keep", async () => {
    const outcome = await inbound({
      MessageSid: "MM-1", From: CUSTOMER, To: MAIN, Body: "This is the leak", NumMedia: "3",
      MediaUrl0: `${media("MM-1")}/ME-photo`, MediaContentType0: "image/png",
      MediaUrl1: `${media("MM-1")}/ME-video`, MediaContentType1: "video/mp4",
      MediaUrl2: `${media("MM-1")}/ME-gone`, MediaContentType2: "image/jpeg",
    });
    if (outcome.kind !== "message") throw new Error(`not stored: ${JSON.stringify(outcome)}`);
    conversationId = outcome.conversationId;
    const [message] = await raw<{ channel: string; media: { storageKey?: string; refused?: string; contentType: string }[] }[]>`
      select channel, media from public.message where id = ${outcome.messageId}`;
    expect(message!.channel).toBe("mms");
    expect(message!.media[0]).toMatchObject({ contentType: "image/png" });
    expect(message!.media[0]!.storageKey).toBeTruthy();
    expect(message!.media[1]!.refused).toContain("A video came with this text");
    expect(message!.media[2]!.refused).toContain("could not be fetched");
  });

  it("shows the picture to somebody who may read the thread, and lists it on the API", async () => {
    const thread = await comms.handlers.getConversation(owner(), { id: conversationId });
    const kept = thread.messages[0]!.media[0]!;
    const picture = await comms.picture(owner(), { conversationId, storageKey: kept.storageKey! });
    expect(picture.contentType).toBe("image/png");
    expect(new Uint8Array(picture.bytes)).toEqual(PNG);
    await expect(comms.picture(owner(["accountant"]), { conversationId, storageKey: kept.storageKey! })).rejects.toThrow();
  });

  it("serves a picture only from the thread it was sent in", async () => {
    const [other] = await raw<{ id: string }[]>`
      insert into public.conversation (organization_id, channel, external_address, status)
      values (${ORG}, 'sms', '+15125557799', 'open') returning id`;
    const [kept] = await raw<{ media: { storageKey: string }[] }[]>`select media from public.message where provider_message_id = 'MM-1'`;
    await expect(comms.picture(owner(), { conversationId: other!.id, storageKey: kept!.media[0]!.storageKey }))
      .rejects.toThrow(/not found/i);
  });
});

run("a picture sent from the inbox", () => {
  let publicKey = "";

  it("sends a photograph as a picture message the carrier can fetch", async () => {
    const sent = await comms.reply(owner(), { id: conversationId, body: "Is this the part?", pictures: [{ bytes: JPEG }] }) as Record<string, unknown>;
    const [message] = await raw<{ channel: string; status: string; media: { url: string; publicKey: string; storageKey: string }[] }[]>`
      select channel, status, media from public.message where id = ${String(sent["id"])}`;
    expect(message).toMatchObject({ channel: "mms", status: "queued" });
    publicKey = message!.media[0]!.publicKey;
    expect(message!.media[0]!.url).toBe(`https://ots.test/api/webhooks/messaging/${TOKEN}/media/${publicKey}`);
  });

  it("hands the carrier the bytes at that address, and nothing at any other", async () => {
    const found = await commsInbound.publicPicture(db(), TOKEN, publicKey);
    expect(found?.contentType).toBe("image/jpeg");
    expect(await commsInbound.publicPicture(db(), TOKEN, "x".repeat(32))).toBeNull();
    expect(await commsInbound.publicPicture(db(), "wrong-token-".repeat(4), publicKey)).toBeNull();
  });

  it("refuses what a carrier would accept and then drop, or what is not a picture", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(JPEG);
    await expect(comms.reply(owner(), { id: conversationId, body: "", pictures: [{ bytes: big }] })).rejects.toThrow(/over 5 MB/);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2]);
    await expect(comms.reply(owner(), { id: conversationId, body: "", pictures: [{ bytes: pdf }] })).rejects.toThrow(ConflictError);
  });

  it("still refuses somebody who replied STOP, picture or not", async () => {
    await inbound({ MessageSid: "MM-stop", From: CUSTOMER, To: MAIN, Body: "STOP" });
    await expect(comms.reply(owner(), { id: conversationId, body: "", pictures: [{ bytes: JPEG }] })).rejects.toThrow(/STOP/);
  });
});
