import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { SYSTEM_USER_ID, time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as comms from "../src/services/comms";
import * as contacts from "../src/services/contacts";
import * as customers from "../src/services/customers";
import * as portalChat from "../src/services/portal-chat";
import * as portalNotice from "../src/services/portal-chat-notice";
import * as portalSettings from "../src/services/portal-settings";
import * as portalSignIn from "../src/services/portal-sign-in";
import { runPass } from "../src/services/workflow-worker";
import "../src/ai/index";
import type { AiProvider, CompletionOutcome, ModelListOutcome, ModelRate } from "../src/ai/provider";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CUSTOMER TAKES BACK A PICTURE THEY SENT IN THEIR CHAT, UNTIL SOMEBODY OPENS IT (M05)
 *
 * The picture is theirs to take back while nobody in the company has opened it
 * (the inbox fetching it records who and when). Then it is gone for both sides: the
 * customer's page shows no picture (and no empty bubble for a message that was only
 * that), the thread tells the office in its place, the stored file is let go, and the
 * words of the message stay. After somebody opened it, it stays, and says why.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-picture-back:org");
const USER = fixtureId("portal-picture-back:user");
const SLUG = "picture-back-co";
const ZONE = "America/Chicago";
const RUN = Date.now().toString(36);

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** The assistant is off for accounts in this file, so nothing asks the model. */
const silentModel: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(): Promise<CompletionOutcome> { throw new Error("The assistant was asked."); },
  async models(): Promise<ModelListOutcome> { return { ok: true, models: [{ id: "fake-model", label: "Fake" }] }; },
};
const deps = (): ai.AiDeps => ({
  readSecret: async () => "sk-test-not-a-key", provider: silentModel,
  now: () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE),
});

let ipSeq = 0;
const ip = () => `198.19.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

/** A customer reachable by text alone once their email is taken off, which is signed in with while it is there. */
async function aTextOnlyCustomer(name: string, phone: string) {
  const email = `${name.split(" ")[0]!.toLowerCase()}.${RUN}@picture-back.test`;
  const c = await customers.create(owner(), {
    type: "residential", name, email, phone, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  await contacts.create(owner(), { name, customerId: c.id, phone, email, preferredChannel: "sms", isPrimary: true });
  const token = await signIn(email);
  await raw`update public.customer set email = null where id = ${c.id}`;
  await raw`update public.contact set email = null where customer_id = ${c.id}`;
  return { id: c.id as string, token, phone };
}

async function signIn(address: string): Promise<string> {
  await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip() });
  const [row] = await raw<{ body: string }[]>`
    select body from public.message where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
    order by created_at desc limit 1`;
  const code = /\b(\d{6})\b/.exec(row?.body ?? "")?.[1];
  if (!code) throw new Error(`No code went to ${address}`);
  const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address, code }, { ip: ip() });
  if (verdict.status !== "signed_in") throw new Error("expected to sign in");
  return verdict.token;
}

const conversationOf = async (customerId: string) =>
  (await raw<{ id: string }[]>`
    select id from public.conversation where organization_id = ${ORG} and customer_id = ${customerId}
    and external_address like 'portal:%' order by created_at desc limit 1`)[0]!.id;

/** What went to a number since the sign in code, newest first. */
const texts = (phone: string) => raw<{ body: string }[]>`
  select body from public.message
  where organization_id = ${ORG} and direction = 'outbound' and to_address = ${phone} and channel = 'sms'
  order by created_at desc`;

const noticeOf = async (conversationId: string) => (await comms.thread(owner(), { id: conversationId })).customerNotice;

const stateOf = async (conversationId: string) => (await raw<{
  held: Date | null; notified: Date | null;
}[]>`select customer_notice_held_at as held, customer_notified_at as notified
     from public.ai_chat_session where conversation_id = ${conversationId}`)[0]!;

/** As if the conversation so far was an hour old and the customer last looked five minutes ago, never told. */
async function longAgo(conversationId: string) {
  await raw`update public.message set created_at = created_at - interval '1 hour' where conversation_id = ${conversationId}`;
  await raw`update public.ai_chat_session set customer_read_at = now() - interval '5 minutes', customer_notified_at = null
    where conversation_id = ${conversationId}`;
}

/** Quiet hours around now, or twelve hours away: the clock cannot decide a test. */
async function quietHours(now: boolean) {
  const hour = Math.floor(time.minutesInDay(new Date(), ZONE) / 60);
  const window = now ? { startHour: hour, endHour: (hour + 2) % 24 } : { startHour: (hour + 12) % 24, endHour: (hour + 13) % 24 };
  await raw`update public.organization
    set settings = coalesce(settings, '{}'::jsonb) || ${raw.json({ quietHours: window })} where id = ${ORG}`;
}

const rateLimitsReset = () => raw`delete from public.public_rate_limit where key like ${'%' + ORG + '%'}`;
const pass = () => portalNotice.releasePass(db(), { force: true });

/** A customer with a chat the office is about to answer at night. */
async function aChat(name: string, phone: string) {
  const who = await aTextOnlyCustomer(name, phone);
  await rateLimitsReset();
  await portalChat.say(db(), { token: who.token, text: "Is anyone coming?" }, { ip: ip() }, deps());
  const conversation = await conversationOf(who.id);
  await longAgo(conversation);
  return { ...who, conversation };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cedar Heating", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@picture-back.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, '+15125559960', 'main', true)`;
  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  await quietHours(true);
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await rateLimitsReset();
  await resetOrg(raw, ORG);
  await raw.end();
});



let nonce = 0;
const jpeg = (size = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, (nonce += 1) % 250)]);
const asInput = (bytes: Buffer, fileName = "photo.jpg") => ({ fileName, contentType: "image/jpeg", bytes: bytes.toString("base64") });

/** A customer who has sent a chat message with pictures. */
async function sent(name: string, phone: string, text: string, count: number) {
  const who = await aTextOnlyCustomer(name, phone);
  await rateLimitsReset();
  const view = await portalChat.say(db(), {
    token: who.token, text, pictures: Array.from({ length: count }, (_, i) => asInput(jpeg(), `photo-${i}.jpg`)),
  }, { ip: ip() }, deps());
  const conversation = await conversationOf(who.id);
  return { ...who, conversation, message: view.messages.at(-1)! };
}

/** The inbox fetching a picture: what records that somebody here opened it. */
const opened = (conversationId: string, storageKey: string) =>
  portalChat.noteChatPictureOpened(owner(), { conversationId, storageKey });

const attachments = (messageId: string) => raw<{ deleted: boolean; seen: boolean }[]>`
  select deleted_at is not null as deleted, seen_at is not null as seen from public.attachment
  where entity_id = ${messageId} order by file_name`;
const mediaOf = async (messageId: string) =>
  (await raw<{ media: { storageKey?: string; refused?: string }[] }[]>`select media from public.message where id = ${messageId}`)[0]!.media;

beforeEach(async () => {
  if (!url) return;
  await rateLimitsReset();
  await quietHours(false);
});

run("taking back a picture nobody has opened", () => {
  it("lets go of it for both sides, leaves the words, and tells the office what happened to it", async () => {
    const ann = await sent("Ann Cedar", "(512) 555-0181", "Here is the leak", 2);
    expect(ann.message.pictures.map((p) => p.takeBack)).toEqual([true, true]);
    const keys = (await mediaOf(ann.message.id)).map((m) => m.storageKey!);

    const view = await portalChat.removePicture(db(), { token: ann.token, messageId: ann.message.id, index: 0 });
    const mine = view.messages.find((m) => m.id === ann.message.id)!;
    expect(mine.text).toBe("Here is the leak");
    expect(mine.pictures.map((p) => p.index)).toEqual([1]);

    const media = await mediaOf(ann.message.id);
    expect(media[0]).toEqual({ url: "", contentType: "image/jpeg", refused: "The customer took this picture back before anyone opened it." });
    expect(media[1]!.storageKey).toBe(keys[1]);
    expect(await attachments(ann.message.id)).toEqual([{ deleted: true, seen: false }, { deleted: false, seen: false }]);
    const [stored] = await raw<{ references: number }[]>`select "references" from public.stored_file where storage_key = ${keys[0]!}`;
    expect(stored!.references).toBe(0);

    /** The office reads the thread and sees why there is a gap. */
    const thread = await comms.handlers.getConversation(owner(), { id: ann.conversation });
    const message = thread.messages.find((m) => m.id === ann.message.id)!;
    expect(message.media[0]!.refused).toBe("The customer took this picture back before anyone opened it.");
    await expect(comms.picture(owner(), { conversationId: ann.conversation, storageKey: keys[0]! })).rejects.toThrow(/not found/i);
    const [audit] = await raw<{ actor_user_id: string | null }[]>`select actor_user_id from public.audit_log
      where organization_id = ${ORG} and entity_id = ${ann.message.id} and action = 'portal.chat_picture_removed'`;
    expect(audit).toBeDefined();

    /** Taking it back again is the same take back. */
    expect((await portalChat.removePicture(db(), { token: ann.token, messageId: ann.message.id, index: 0 })).messages).toHaveLength(view.messages.length);
  });

  it("removes a message that was only that picture from the customer's page, and leaves it in the office's thread", async () => {
    const bo = await sent("Bo Cedar", "(512) 555-0182", "", 1);
    const view = await portalChat.removePicture(db(), { token: bo.token, messageId: bo.message.id, index: 0 });
    expect(view.messages.find((m) => m.id === bo.message.id)).toBeUndefined();
    const thread = await comms.handlers.getConversation(owner(), { id: bo.conversation });
    expect(thread.messages.find((m) => m.id === bo.message.id)!.media[0]!.refused).toMatch(/took this picture back/);
  });

  it("is refused once somebody in the company has opened it, and the picture stays", async () => {
    const cy = await sent("Cy Cedar", "(512) 555-0183", "Look at this", 1);
    const [key] = (await mediaOf(cy.message.id)).map((m) => m.storageKey!);
    expect(await opened(cy.conversation, key!)).toBe(1);
    /** Opening it again records nothing more. */
    expect(await opened(cy.conversation, key!)).toBe(0);
    const [seen] = await raw<{ seen_by_user_id: string | null }[]>`select seen_by_user_id from public.attachment where entity_id = ${cy.message.id}`;
    expect(seen!.seen_by_user_id).toBe(USER);

    await expect(portalChat.removePicture(db(), { token: cy.token, messageId: cy.message.id, index: 0 }))
      .rejects.toThrow("We have already opened that picture, so it stays in the chat.");
    const view = await portalChat.read(db(), { token: cy.token });
    expect(view.messages.find((m) => m.id === cy.message.id)!.pictures).toEqual([
      expect.objectContaining({ index: 0, takeBack: false }),
    ]);
    expect((await attachments(cy.message.id))[0]).toEqual({ deleted: false, seen: true });
  });

  it("is only the customer's own picture, in their own chat", async () => {
    const di = await sent("Di Cedar", "(512) 555-0184", "Mine", 1);
    const ed = await sent("Ed Cedar", "(512) 555-0185", "His", 1);
    await expect(portalChat.removePicture(db(), { token: di.token, messageId: ed.message.id, index: 0 })).rejects.toThrow(/not found/i);
    await expect(portalChat.removePicture(db(), { token: di.token, messageId: di.message.id, index: 2 })).rejects.toThrow(/not found/i);
    await expect(portalChat.removePicture(db(), { token: di.token, messageId: crypto.randomUUID(), index: 0 })).rejects.toThrow(/not found/i);
    expect((await mediaOf(ed.message.id))[0]!.storageKey).toBeTruthy();

    /** A picture the office sent is not theirs to take back. */
    await comms.reply(owner(), { id: di.conversation, body: "Here is the part", pictures: [{ bytes: jpeg(), fileName: "part.jpg" }] });
    const view = await portalChat.read(db(), { token: di.token });
    const office = view.messages.find((m) => m.from === "person" && m.pictures.length > 0)!;
    expect(office.pictures[0]!.takeBack).toBe(false);
    await expect(portalChat.removePicture(db(), { token: di.token, messageId: office.id, index: 0 })).rejects.toThrow(/not found/i);
  });
});
