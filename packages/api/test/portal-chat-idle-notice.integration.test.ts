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
 * THE CUSTOMER IS TOLD WHEN THE QUIET CHAT RULE CLOSES THEIR CHAT (M05)
 *
 * The company's rule closes an account chat the company answered last and the
 * customer has not written in for the days it chose. The customer used to learn
 * it only on their next visit. Now they are told once, by the way they would rather
 * hear, through consent and the STOP list and never inside the company's quiet
 * hours: a text the hours stop is kept and sent when they end, unless the customer
 * opened the chat meanwhile, the company switched the notice off, or it is more
 * than two days old.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-idle-notice:org");
const USER = fixtureId("portal-idle-notice:user");
const SLUG = "idle-notice-co";
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
  const email = `${name.split(" ")[0]!.toLowerCase()}.${RUN}@idle-notice.test`;
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
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@idle-notice.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, '+15125559959', 'main', true)`;
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


const workerCtx = (): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId: ORG, roles: [], grants: [], agentId: "portal-chat-idle" }, db: db(),
});
const closeQuiet = (now = new Date()) => inTenant(workerCtx(), (tx) => portalChat.closeIdleIn(tx, workerCtx(), now));

/** The customer wrote, the office answered, and it has been `days` days. */
async function quietChat(name: string, phone: string, days = 5) {
  const who = await aTextOnlyCustomer(name, phone);
  await rateLimitsReset();
  await portalChat.say(db(), { token: who.token, text: "Is anyone coming?" }, { ip: ip() }, deps());
  const conversation = await conversationOf(who.id);
  await comms.reply(owner(), { id: conversation, body: "Yes, tomorrow." });
  await raw`update public.message set created_at = created_at - (${days} || ' days')::interval where conversation_id = ${conversation}`;
  /** The reply's own notice is not what this file is about. */
  await raw`update public.ai_chat_session set customer_notice = null, customer_notice_held_at = null, customer_notice_kind = null,
    customer_read_at = now() - (${days} || ' days')::interval where conversation_id = ${conversation}`;
  return { ...who, conversation };
}

const kindOf = async (conversationId: string) => (await raw<{ kind: string | null; held: Date | null }[]>`
  select customer_notice_kind as kind, customer_notice_held_at as held from public.ai_chat_session
  where conversation_id = ${conversationId}`)[0]!;

beforeEach(async () => {
  if (!url) return;
  await rateLimitsReset();
  await raw`update public.organization set settings = settings - 'portal' where id = ${ORG}`;
  await raw`update public.ai_chat_session set status = 'closed' where organization_id = ${ORG}`;
  await portalSettings.set(owner(), { chatIdleCloseDays: 3, chatReplyNotice: true });
  await quietHours(false);
});

run("telling the customer their quiet chat was closed", () => {
  it("texts a customer reachable by text, once, in plain words that carry nothing of what was said", async () => {
    const ivy = await quietChat("Ivy Cedar", "(512) 555-0171");
    expect(await closeQuiet()).toEqual([ivy.conversation]);
    const sent = await texts("+15125550171");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Cedar Heating closed your chat because it had been quiet for 5 days");
    expect(sent[0]!.body).toContain(`/portal/${SLUG}/account/chat`);
    expect(sent[0]!.body).not.toContain("tomorrow");
    expect(await noticeOf(ivy.conversation)).toBe("Told by text that the chat was closed.");
    const [audit] = await raw<{ after: { told: boolean } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and entity_id = ${ivy.conversation}
      and action = 'portal.chat_idle_noticed'`;
    expect(audit!.after).toMatchObject({ told: true, held: false });
    /** A second pass finds the chat already closed and tells nobody again. */
    expect(await closeQuiet()).toEqual([]);
    expect(await texts("+15125550171")).toHaveLength(1);
  });

  it("emails a customer who would rather be emailed, and the email names the company and gives the link", async () => {
    const email = `emmy.${RUN}@idle-notice.test`;
    const c = await customers.create(owner(), {
      type: "residential", name: "Emmy Cedar", email, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const token = await signIn(email);
    await rateLimitsReset();
    await portalChat.say(db(), { token, text: "Hello?" }, { ip: ip() }, deps());
    const conversation = await conversationOf(c.id as string);
    await comms.reply(owner(), { id: conversation, body: "Hi Emmy." });
    await raw`update public.message set created_at = created_at - interval '4 days' where conversation_id = ${conversation}`;
    await raw`update public.ai_chat_session set customer_read_at = now() - interval '4 days' where conversation_id = ${conversation}`;
    await closeQuiet();
    const [mail] = await raw<{ subject: string | null; body: string }[]>`
      select subject, body from public.message where organization_id = ${ORG} and direction = 'outbound'
      and to_address = ${email} and subject like '%closed your chat%'`;
    expect(mail!.subject).toBe("Cedar Heating closed your chat");
    expect(mail!.body).toContain(`/portal/${SLUG}/account/chat`);
    expect(await noticeOf(conversation)).toMatch(/^Told by email that the chat was closed/);
  });

  it("keeps a text the quiet hours stopped and sends it when they end", async () => {
    await quietHours(true);
    const kay = await quietChat("Kay Cedar", "(512) 555-0172");
    await closeQuiet();
    expect(await texts("+15125550172")).toHaveLength(0);
    expect(await noticeOf(kay.conversation)).toMatch(/^Waiting for your quiet hours to end to tell them the chat was closed\./);
    expect(await kindOf(kay.conversation)).toMatchObject({ kind: "idle_close" });
    expect((await kindOf(kay.conversation)).held).not.toBeNull();

    expect((await pass()).find((r) => r.organizationId === ORG)).toMatchObject({ told: 0, waiting: 1 });
    await quietHours(false);
    expect((await pass()).find((r) => r.organizationId === ORG)).toMatchObject({ told: 1, dropped: 0 });
    const sent = await texts("+15125550172");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("closed your chat");
    expect(await noticeOf(kay.conversation)).toBe("Told by text that the chat was closed.");
    expect(await kindOf(kay.conversation)).toMatchObject({ kind: null, held: null });
    /** Once: the next pass sends nothing. */
    await pass();
    expect(await texts("+15125550172")).toHaveLength(1);
  });

  it("drops the kept text when the customer opened the chat meanwhile, and says so", async () => {
    await quietHours(true);
    const lou = await quietChat("Lou Cedar", "(512) 555-0173");
    await closeQuiet();
    await portalChat.read(db(), { token: lou.token });
    await quietHours(false);
    expect((await pass()).find((r) => r.organizationId === ORG)).toMatchObject({ told: 0, dropped: 1 });
    expect(await texts("+15125550173")).toHaveLength(0);
    expect(await noticeOf(lou.conversation)).toBe("Not told that the chat was closed: they opened the chat after it closed and have seen it.");
    expect((await kindOf(lou.conversation)).held).toBeNull();
  });

  it("is not sent to a number that replied STOP, and consent is asked at the moment it would go", async () => {
    const stu = await quietChat("Stu Cedar", "(512) 555-0174");
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, '+15125550174', 'sms', 'stop')`;
    await closeQuiet();
    expect(await texts("+15125550174")).toHaveLength(0);
    expect(await noticeOf(stu.conversation)).toMatch(/^Not told that the chat was closed\. Not texted: .*STOP/);
    expect((await kindOf(stu.conversation)).held).toBeNull();
  });

  it("follows the company's chat notices switch", async () => {
    await portalSettings.set(owner(), { chatReplyNotice: false });
    const ned = await quietChat("Ned Cedar", "(512) 555-0175");
    await closeQuiet();
    expect(await texts("+15125550175")).toHaveLength(0);
    expect(await noticeOf(ned.conversation)).toMatch(/^Not told that the chat was closed: chat notices are turned off/);
  });

  it("drops a kept text that is more than two days old", async () => {
    await quietHours(true);
    const oli = await quietChat("Oli Cedar", "(512) 555-0176");
    await closeQuiet();
    await raw`update public.ai_chat_session set customer_notice_held_at = now() - interval '3 days' where conversation_id = ${oli.conversation}`;
    await quietHours(false);
    await pass();
    expect(await texts("+15125550176")).toHaveLength(0);
    expect(await noticeOf(oli.conversation)).toMatch(/more than two days after it closed/);
  });

  it("does not tell a customer who has the chat open at that moment, and never for a chat the customer closed", async () => {
    const pam = await quietChat("Pam Cedar", "(512) 555-0177");
    await raw`update public.ai_chat_session set customer_read_at = now() - interval '5 seconds' where conversation_id = ${pam.conversation}`;
    await closeQuiet();
    expect(await texts("+15125550177")).toHaveLength(0);
    expect(await noticeOf(pam.conversation)).toMatch(/they had the chat open/);

    const quin = await quietChat("Quin Cedar", "(512) 555-0178");
    await portalChat.close(db(), { token: quin.token });
    expect(await closeQuiet()).toEqual([]);
    expect(await texts("+15125550178")).toHaveLength(0);
  });
});
