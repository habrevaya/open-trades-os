import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { agents as coreAgents, time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as comms from "../src/services/comms";
import * as contacts from "../src/services/contacts";
import * as customers from "../src/services/customers";
import * as portalAccess from "../src/services/portal-access";
import * as portalChat from "../src/services/portal-chat";
import * as portalFiles from "../src/services/portal-files";
import * as portalSettings from "../src/services/portal-settings";
import * as portalSignIn from "../src/services/portal-sign-in";
import "../src/ai/index";
import type { AiProvider, CompletionOutcome, ModelListOutcome, ModelRate } from "../src/ai/provider";
import { ConflictError, NotFoundError, TooManyRequestsError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE OFFICE ANSWERS A CHAT FROM A CUSTOMER'S ACCOUNT (M05)
 *
 * Two things the customer gets that the chat page alone did not give them.
 *
 * They are TOLD when the office answers: once, by the way they would rather
 * hear from the company, through the gates every message goes through (consent,
 * STOP, quiet hours), with a link and none of the reply, and not again until
 * they have read it. Nothing is sent to somebody looking at the page, nor when
 * the company turned the notice off, and a contact who signed in as themselves
 * is told at their own address. The account page can count what is unread.
 *
 * They can send PICTURES, and the office can send them back. The customer's are
 * held to the customer upload rules and the hour a file added to a job counts
 * against; a message with one goes to a person; nobody else can fetch one.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-chat-notice:org");
const USER = fixtureId("portal-chat-notice:user");
const SLUG = "chat-notice-co";
const ZONE = "America/Chicago";
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@chat-notice.test`;
const SAM = `sam.${RUN}@chat-notice.test`;
const TEX = `tex.${RUN}@chat-notice.test`;
const EVE = `eve.${RUN}@chat-notice.test`;
const FAY = `fay.${RUN}@chat-notice.test`;
const TEX_PHONE = "(512) 555-0142";
const TEX_E164 = "+15125550142";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A scripted model that must never be asked: a message with a picture goes to a person. */
const silentModel: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(): Promise<CompletionOutcome> { throw new Error("The assistant was asked to read a picture."); },
  async models(): Promise<ModelListOutcome> { return { ok: true, models: [{ id: "fake-model", label: "Fake" }] }; },
};
const deps = (): ai.AiDeps => ({
  readSecret: async () => "sk-test-not-a-key", provider: silentModel,
  now: () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE),
});

let ipSeq = 0;
const ip = () => `198.19.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

/** Bytes that are what they say they are, and distinct, so nothing is the same file twice. */
let nonce = 0;
const jpeg = (size = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, (nonce += 1) % 250)]);
const asInput = (bytes: Buffer, fileName = "photo.jpg") => ({ fileName, contentType: "image/jpeg", bytes: bytes.toString("base64") });

async function aCustomer(name: string, email: string, extra: { phone?: string } = {}) {
  const c = await customers.create(owner(), {
    type: "residential", name, email, ...extra, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  return c.id as string;
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

const conversationOf = async (customerId: string, like = "portal:%") =>
  (await raw<{ id: string }[]>`
    select id from public.conversation where organization_id = ${ORG} and customer_id = ${customerId}
    and external_address like ${like} order by created_at desc limit 1`)[0]!.id;

/** What went to an address since the test began, by channel, newest first. */
const sentTo = (address: string) => raw<{ channel: string; subject: string | null; body: string }[]>`
  select channel::text as channel, subject, body from public.message
  where organization_id = ${ORG} and direction = 'outbound' and to_address = ${address}
    and body not like '%is your Cedar Heating sign in code%'
  order by created_at desc`;

const customerIdOf = async (email: string) =>
  (await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} and email = ${email}`)[0]!.id;

const noticeOf = async (conversationId: string) => (await comms.thread(owner(), { id: conversationId })).customerNotice;

/**
 * As if the conversation so far was an hour old, the customer last looked five
 * minutes ago, and (when `notified`) was told ten minutes ago.
 */
async function longAgo(conversationId: string, notified = true) {
  await raw`update public.message set created_at = created_at - interval '1 hour' where conversation_id = ${conversationId}`;
  await raw`update public.ai_chat_session set customer_read_at = now() - interval '5 minutes'
    where conversation_id = ${conversationId}`;
  if (notified) {
    await raw`update public.ai_chat_session set customer_notified_at = now() - interval '10 minutes'
      where conversation_id = ${conversationId}`;
  } else {
    await raw`update public.ai_chat_session set customer_notified_at = null where conversation_id = ${conversationId}`;
  }
}

/** This company's counters only: another file's chat is counting its own at the same time. */
const rateLimitsReset = () => raw`delete from public.public_rate_limit where key like ${'%' + ORG + '%'}`;

let dana = "";
let tex = "";
let eve = "";
let danaToken = "";
let texToken = "";
let eveToken = "";
let fayToken = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cedar Heating", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@chat-notice.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, '+15125559948', 'main', true)`;
  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  dana = await aCustomer("Dana Cedar", DANA);
  tex = await aCustomer("Tex Cedar", TEX, { phone: TEX_PHONE });
  await contacts.create(owner(), { name: "Tex Cedar", customerId: tex, phone: TEX_PHONE, email: TEX, preferredChannel: "sms", isPrimary: true });
  eve = await aCustomer("Eve Cedar", EVE);
  danaToken = await signIn(DANA);
  texToken = await signIn(TEX);
  eveToken = await signIn(EVE);
  await aCustomer("Fay Cedar", FAY);
  fayToken = await signIn(FAY);
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await rateLimitsReset();
  await resetOrg(raw, ORG);
  await raw.end();
});

run("telling a customer the office answered", () => {
  let conversation = "";

  it("is not sent to somebody who has the chat open, and says why on the chat", async () => {
    await portalChat.say(db(), { token: danaToken, text: "The furnace is out" }, { ip: ip() }, deps());
    conversation = await conversationOf(dana);
    await comms.reply(owner(), { id: conversation, body: "Looking now." });
    expect(await sentTo(DANA)).toHaveLength(0);
    expect(await noticeOf(conversation)).toBe("Not told: they had the chat open and see the answer there.");
  });

  it("is an email with a link and none of the reply, by the way an email customer would rather hear", async () => {
    await longAgo(conversation, false);
    await comms.reply(owner(), { id: conversation, body: "We can be there at nine, bring the 2 inch filter." });
    const [mail, ...others] = await sentTo(DANA);
    expect(others).toHaveLength(0);
    expect(mail).toMatchObject({ channel: "email", subject: "Cedar Heating answered your message" });
    expect(mail!.body).toContain(`/portal/${SLUG}/account/chat`);
    expect(mail!.body).toContain("Hi Dana,");
    expect(mail!.body).not.toContain("2 inch filter");
    expect(await noticeOf(conversation)).toBe("Told by email.");
    const [audit] = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${conversation}
      and action = 'portal.chat_reply_noticed' order by created_at desc limit 1`;
    expect(audit).toBeTruthy();
  });

  it("is sent once until they have read it, and the account page counts what is waiting", async () => {
    await comms.reply(owner(), { id: conversation, body: "And a second thing." });
    await comms.reply(owner(), { id: conversation, body: "And a third." });
    expect(await sentTo(DANA)).toHaveLength(1);
    expect((await portalChat.unreadReplies(db(), { token: danaToken })).unread).toBe(3);
    /** Asking the count does not read anything. */
    expect((await portalChat.unreadReplies(db(), { token: danaToken })).unread).toBe(3);

    const seen = await portalChat.read(db(), { token: danaToken });
    expect(seen.messages.filter((m) => m.from === "person")).toHaveLength(4);
    expect((await portalChat.unreadReplies(db(), { token: danaToken })).unread).toBe(0);
  });

  it("is sent again after they have read the last one", async () => {
    await longAgo(conversation, true);
    await comms.reply(owner(), { id: conversation, body: "Running ten minutes late." });
    expect(await sentTo(DANA)).toHaveLength(2);
    expect((await portalChat.unreadReplies(db(), { token: danaToken })).unread).toBe(1);
  });

  it("counts a customer's unread answers for them and nobody else", async () => {
    expect((await portalChat.unreadReplies(db(), { token: eveToken })).unread).toBe(0);
    expect((await portalChat.unreadReplies(db(), { token: texToken })).unread).toBe(0);
  });

  it("can be turned off, and says so on the chat; turning it back on tells them at the next answer", async () => {
    await portalChat.read(db(), { token: danaToken });
    await longAgo(conversation, true);
    const off = await portalSettings.set(owner(), { chatReplyNotice: false });
    expect(off.chatReplyNotice).toBe(false);
    await comms.reply(owner(), { id: conversation, body: "No notice for this one." });
    expect(await sentTo(DANA)).toHaveLength(2);
    expect(await noticeOf(conversation)).toMatch(/turned off/);

    const on = await portalSettings.set(owner(), { chatReplyNotice: true });
    expect(on.chatReplyNotice).toBe(true);
    await comms.reply(owner(), { id: conversation, body: "Back on." });
    expect(await sentTo(DANA)).toHaveLength(3);
  });

  it("is on for a company that never touched the setting", async () => {
    const view = await portalSettings.get(owner());
    expect(view.chatReplyNotice).toBe(true);
  });
});

/**
 * The company's quiet hours, set so the clock cannot decide a test: by default
 * a text waits from nine at night to eight in the morning, and the suite runs
 * at any hour. The window is one hour, twelve hours from now, or the hour now
 * and the two after it when `now` is asked for.
 */
async function quietHours(now: boolean) {
  const hour = Math.floor(time.minutesInDay(new Date(), ZONE) / 60);
  const window = now ? { startHour: hour, endHour: (hour + 2) % 24 } : { startHour: (hour + 12) % 24, endHour: (hour + 13) % 24 };
  await raw`update public.organization
    set settings = coalesce(settings, '{}'::jsonb) || ${raw.json({ quietHours: window })}
    where id = ${ORG}`;
}

run("by text, through the gates texts go through", () => {
  let conversation = "";

  beforeAll(async () => { if (url) await quietHours(false); });

  it("is a text to the number on the record when the customer prefers texts", async () => {
    await portalChat.say(db(), { token: texToken, text: "Can you come Friday?" }, { ip: ip() }, deps());
    conversation = await conversationOf(tex);
    await longAgo(conversation, false);
    await comms.reply(owner(), { id: conversation, body: "Friday works." });
    const [text] = await sentTo(TEX_E164);
    expect(text).toMatchObject({ channel: "sms" });
    expect(text!.body).toMatch(/^Hi Tex, Cedar Heating answered your message\. Read it and reply here: .*\/portal\/chat-notice-co\/account\/chat$/);
    expect(text!.body).not.toContain("Friday works");
    expect((await sentTo(TEX))).toHaveLength(0);
    expect(await noticeOf(conversation)).toBe("Told by text.");
  });

  it("is an email instead when they replied STOP", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, ${TEX_E164}, 'sms', 'stop')`;
    await portalChat.read(db(), { token: texToken });
    await longAgo(conversation, true);
    await comms.reply(owner(), { id: conversation, body: "Second answer." });
    expect(await sentTo(TEX_E164)).toHaveLength(1);
    const [mail] = await sentTo(TEX);
    expect(mail).toMatchObject({ channel: "email" });
    expect(await noticeOf(conversation)).toMatch(/^Told by email \(Not texted: .*STOP/);
    await raw`delete from public.suppression where organization_id = ${ORG}`;
  });

  it("never texts inside the company's quiet hours, and emails instead", async () => {
    await quietHours(true);
    await portalChat.read(db(), { token: texToken });
    await longAgo(conversation, true);
    await comms.reply(owner(), { id: conversation, body: "Third answer." });
    expect(await sentTo(TEX_E164)).toHaveLength(1);
    expect(await sentTo(TEX)).toHaveLength(2);
    expect(await noticeOf(conversation)).toMatch(/quiet hours/);
    await quietHours(false);
  });

  it("says plainly when there is no way to reach them, and tries again at the next answer", async () => {
    await raw`update public.customer set email = null where id = ${eve}`;
    await portalChat.say(db(), { token: eveToken, text: "Hello?" }, { ip: ip() }, deps());
    const eveChat = await conversationOf(eve);
    await longAgo(eveChat, false);
    await comms.reply(owner(), { id: eveChat, body: "Hi Eve." });
    expect(await noticeOf(eveChat)).toBe("Not told. Not emailed: no email address to write to. Not texted: no mobile number to text.");
    const [chat] = await raw<{ customer_notified_at: Date | null }[]>`
      select customer_notified_at from public.ai_chat_session where conversation_id = ${eveChat}`;
    expect(chat!.customer_notified_at).toBeNull();
    await raw`update public.customer set email = ${EVE} where id = ${eve}`;
    await comms.reply(owner(), { id: eveChat, body: "Trying again." });
    expect(await noticeOf(eveChat)).toBe("Told by email.");
  });
});

run("a contact who signed in as themselves", () => {
  it("is told at their own address, not the customer's", async () => {
    const sam = await contacts.create(owner(), { name: "Sam Cedar", customerId: dana, email: SAM, preferredChannel: "email" });
    await portalAccess.setContactAccess(owner(), { id: sam.id, allowed: true });
    const samToken = await signIn(SAM);
    await portalChat.say(db(), { token: samToken, text: "It is Sam, about the furnace" }, { ip: ip() }, deps());
    const conversation = await conversationOf(dana, `portal:${dana}:%`);
    await longAgo(conversation, false);
    const danaBefore = (await sentTo(DANA)).length;
    await comms.reply(owner(), { id: conversation, body: "Hi Sam." });
    const [mail] = await sentTo(SAM);
    expect(mail).toMatchObject({ channel: "email", subject: "Cedar Heating answered your message" });
    expect(mail!.body).toContain("Hi Sam,");
    expect((await sentTo(DANA)).length).toBe(danaBefore);
    /** Sam's chat is Sam's: Dana's own count is not Sam's. */
    expect((await portalChat.unreadReplies(db(), { token: samToken })).unread).toBe(1);
  });
});

run("a website chat", () => {
  it("is not told of anything, and still takes words only", async () => {
    const [website] = await raw<{ id: string }[]>`
      insert into public.conversation (organization_id, channel, external_address, internal_address, subject, status, last_message_at)
      values (${ORG}, 'webchat', 'visitor-token-1', 'website', 'Website chat', 'open', now()) returning id`;
    await raw`insert into public.ai_chat_session (organization_id, conversation_id, channel, status, token_hash)
      values (${ORG}, ${website!.id}, 'web', 'handed_off', 'hash-visitor-1')`;
    const before = await raw`select id from public.message where organization_id = ${ORG} and direction = 'outbound'`;
    await comms.reply(owner(), { id: website!.id, body: "Hello, this is the office." });
    const after = await raw`select id from public.message where organization_id = ${ORG} and direction = 'outbound'`;
    expect(after.length).toBe(before.length + 1);
    await expect(comms.reply(owner(), {
      id: website!.id, body: "Here", pictures: [{ bytes: jpeg(), fileName: "a.jpg" }],
    })).rejects.toThrow(/words only/);
  });
});

run("pictures from the customer", () => {
  beforeEach(async () => {
    await raw`delete from public.public_rate_limit where key like ${'portal-chat%' + ORG + '%'}`;
  });

  it("are kept, shown on their page, and served to them alone", async () => {
    const bytes = jpeg(900);
    const sent = await portalChat.say(db(), {
      token: danaToken, text: "Here is the unit", pictures: [asInput(bytes, "../unit.jpg")],
    }, { ip: ip() }, deps());
    const message = sent.messages.at(-1)!;
    expect(message).toMatchObject({ from: "visitor", text: "Here is the unit" });
    expect(message.pictures).toEqual([{ index: 0, contentType: "image/jpeg", name: "unit.jpg", shown: true }]);

    const shown = await portalChat.picture(db(), { token: danaToken, messageId: message.id, index: 0 });
    expect(shown.contentType).toBe("image/jpeg");
    expect(Buffer.compare(shown.bytes, bytes)).toBe(0);

    /** Another customer's sign in, a position with nothing, and a made up message are all not found. */
    await expect(portalChat.picture(db(), { token: eveToken, messageId: message.id, index: 0 })).rejects.toThrow(NotFoundError);
    await expect(portalChat.picture(db(), { token: danaToken, messageId: message.id, index: 1 })).rejects.toThrow(NotFoundError);
    await expect(portalChat.picture(db(), {
      token: danaToken, messageId: "00000000-0000-4000-8000-000000000000", index: 0,
    })).rejects.toThrow(NotFoundError);

    /** The office sees it in the thread and can open it. */
    const conversation = await conversationOf(dana, `portal:${dana}`);
    const thread = await comms.thread(owner(), { id: conversation });
    const stored = thread.messages.find((m) => (m as { id: string }).id === message.id) as { media: { storageKey: string }[] };
    const opened = await comms.picture(owner(), { conversationId: conversation, storageKey: stored.media[0]!.storageKey });
    expect(opened.contentType).toBe("image/jpeg");
    const [filed] = await raw<{ kind: string; uploaded_by_customer_id: string }[]>`
      select kind, uploaded_by_customer_id from public.attachment
      where organization_id = ${ORG} and entity_type = 'message' and entity_id = ${message.id}`;
    expect(filed).toEqual({ kind: "chat_picture", uploaded_by_customer_id: dana });
  });

  it("can be sent alone, with no words", async () => {
    const sent = await portalChat.say(db(), { token: danaToken, text: "", pictures: [asInput(jpeg())] }, { ip: ip() }, deps());
    expect(sent.messages.at(-1)).toMatchObject({ from: "visitor", text: "" });
    const [row] = await raw<{ last_message_preview: string }[]>`
      select last_message_preview from public.conversation where id = ${await conversationOf(dana, `portal:${dana}`)}`;
    expect(row!.last_message_preview).toBe("Picture");
    await expect(portalChat.say(db(), { token: danaToken, text: "  " }, { ip: ip() }, deps())).rejects.toThrow(ConflictError);
  });

  it("refuse the whole message for a program, a PDF, something that is not a picture, or too many or too big", async () => {
    const count = async () => (await raw`select id from public.message where organization_id = ${ORG}`).length;
    const before = await count();
    const refused = (pictures: ReturnType<typeof asInput>[], words: RegExp) =>
      expect(portalChat.say(db(), { token: danaToken, text: "x", pictures }, { ip: ip() }, deps())).rejects.toThrow(words);

    await refused([asInput(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 1)]), "photo.jpg")], /program or a script/);
    await refused([asInput(Buffer.from("%PDF-1.4 hello"), "scan.pdf")], /only a photo/);
    await refused([asInput(Buffer.from("not a picture at all"), "photo.jpg")], /only a photo/);
    await refused([asInput(jpeg(), "run.exe")], /program or a script/);
    await refused([asInput(jpeg()), asInput(jpeg()), asInput(jpeg()), asInput(jpeg())], /up to 3 pictures/);
    await refused([asInput(Buffer.concat([jpeg(), Buffer.alloc(5 * 1024 * 1024)]))], /5 MB/);
    /** One good picture and one bad: nothing is half sent. */
    await refused([asInput(jpeg()), asInput(Buffer.from("%PDF-1.4 hello"), "scan.pdf")], /only a photo/);
    expect(await count()).toBe(before);
  });

  it("count against the hour a file added to a job counts against", async () => {
    await raw`delete from public.public_rate_limit where key like ${'%' + ORG + '%'}`;
    for (let i = 0; i < 19; i += 1) await portalFiles.countUpload(db(), ORG, dana);
    await portalChat.say(db(), { token: danaToken, text: "twentieth", pictures: [asInput(jpeg())] }, { ip: ip() }, deps());
    await expect(portalChat.say(db(), {
      token: danaToken, text: "twenty first", pictures: [asInput(jpeg())],
    }, { ip: ip() }, deps())).rejects.toThrow(TooManyRequestsError);
    await raw`delete from public.public_rate_limit where key like ${'portal-file:' + ORG + '%'}`;
  });

  it("go to a person, and the assistant is never asked to read one", async () => {
    await agents.configure(owner(), {
      agent: "chat",
      settings: {
        ...coreAgents.defaultSettings("chat"), enabled: true, runAsUserId: USER,
        chat: { ...coreAgents.defaultSettings("chat").chat, portal: true },
      },
    });
    await raw`delete from public.public_rate_limit where key like ${'portal-chat%' + ORG + '%'}`;
    const sent = await portalChat.say(db(), {
      token: fayToken, text: "", pictures: [asInput(jpeg())],
    }, { ip: ip() }, deps());
    expect(sent.assistant).toBe(true);
    expect(sent.status).toBe("handed_off");
    expect(sent.messages[0]).toMatchObject({ from: "assistant", text: expect.stringMatching(/automated assistant/) });
    expect(sent.messages.at(-1)!.pictures).toHaveLength(1);
    const [task] = await raw<{ title: string }[]>`
      select title from public.task where organization_id = ${ORG} and entity_id = ${await conversationOf(await customerIdOf(FAY))}
      order by created_at desc limit 1`;
    expect(task!.title).toBe("A chat from a customer's account needs a person");
  });
});

run("pictures from the office", () => {
  beforeEach(async () => {
    await raw`delete from public.public_rate_limit where key like ${'portal-chat%' + ORG + '%'}`;
  });

  it("reach the customer's page, are served to them alone, and the notice still goes", async () => {
    const conversation = await conversationOf(dana, `portal:${dana}`);
    await portalChat.read(db(), { token: danaToken });
    await longAgo(conversation, true);
    const before = (await sentTo(DANA)).length;
    const bytes = jpeg(700);
    await comms.reply(owner(), { id: conversation, body: "This is the part we will bring.", pictures: [{ bytes, fileName: "part.jpg" }] });

    const seen = await portalChat.read(db(), { token: danaToken });
    const reply = seen.messages.at(-1)!;
    expect(reply).toMatchObject({ from: "person", text: "This is the part we will bring." });
    expect(reply.pictures).toEqual([{ index: 0, contentType: "image/jpeg", name: "part.jpg", shown: true }]);
    const fetched = await portalChat.picture(db(), { token: danaToken, messageId: reply.id, index: 0 });
    expect(Buffer.compare(fetched.bytes, bytes)).toBe(0);
    await expect(portalChat.picture(db(), { token: eveToken, messageId: reply.id, index: 0 })).rejects.toThrow(NotFoundError);
    expect((await sentTo(DANA)).length).toBe(before + 1);
  });

  it("can go alone, and are checked by their bytes like any reply", async () => {
    const conversation = await conversationOf(dana, `portal:${dana}`);
    await comms.reply(owner(), { id: conversation, body: "", pictures: [{ bytes: jpeg(), fileName: "x.jpg" }] });
    await expect(comms.reply(owner(), {
      id: conversation, body: "hi", pictures: [{ bytes: Buffer.from("MZ not a picture"), fileName: "x.jpg" }],
    })).rejects.toThrow(ConflictError);
    await expect(comms.reply(owner(), {
      id: conversation, body: "hi", pictures: Array.from({ length: 4 }, () => ({ bytes: jpeg(), fileName: "x.jpg" })),
    })).rejects.toThrow(/up to 3/);
  });
});
