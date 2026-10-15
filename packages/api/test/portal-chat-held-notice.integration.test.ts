import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
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
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CHAT ANSWER NOTICE HELD BY QUIET HOURS IS SENT WHEN THEY END (M05)
 *
 * A customer who can only be reached by text, answered at night, used to hear
 * nothing: the company's quiet hours stopped the text and it was never tried
 * again. Now the notice is kept and the worker sends it when the hours end,
 * unless the customer read the chat meanwhile. Still once until they read it,
 * and still through consent and STOP at the moment it is sent.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-held-notice:org");
const USER = fixtureId("portal-held-notice:user");
const SLUG = "held-notice-co";
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
  const email = `${name.split(" ")[0]!.toLowerCase()}.${RUN}@held-notice.test`;
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
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@held-notice.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, '+15125559958', 'main', true)`;
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

run("a notice that only a text could carry, answered inside quiet hours", () => {
  let pat: Awaited<ReturnType<typeof aChat>>;

  it("is kept, with the reason on the chat, instead of dropped", async () => {
    pat = await aChat("Pat Cedar", "(512) 555-0161");
    await comms.reply(owner(), { id: pat.conversation, body: "We will be there at nine." });
    expect(await texts("+15125550161")).toHaveLength(0);
    expect(await noticeOf(pat.conversation)).toMatch(/^Waiting for your quiet hours to end\. Not texted: it is inside your quiet hours.* Not emailed: no email address to write to\. The text goes then/);
    const state = await stateOf(pat.conversation);
    expect(state.held).not.toBeNull();
    expect(state.notified).toBeNull();
  });

  it("stays kept while the hours go on, and nothing is sent", async () => {
    const results = await pass();
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ told: 0, waiting: 1 });
    expect(await texts("+15125550161")).toHaveLength(0);
    expect((await stateOf(pat.conversation)).held).not.toBeNull();
  });

  it("is one notice however many answers came in the night", async () => {
    await comms.reply(owner(), { id: pat.conversation, body: "Second answer." });
    await comms.reply(owner(), { id: pat.conversation, body: "Third answer." });
    await quietHours(false);
    const results = await pass();
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ told: 1, dropped: 0 });
    const sent = await texts("+15125550161");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(`/portal/${SLUG}/account/chat`);
    expect(sent[0]!.body).not.toContain("Second answer");
    expect(await noticeOf(pat.conversation)).toBe("Told by text.");
    const state = await stateOf(pat.conversation);
    expect(state.held).toBeNull();
    expect(state.notified).not.toBeNull();
    const [audit] = await raw<{ after: { released?: boolean; told: boolean } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and entity_id = ${pat.conversation}
      and action = 'portal.chat_reply_noticed' order by created_at desc limit 1`;
    expect(audit!.after).toMatchObject({ told: true, released: true });
  });

  it("is not sent again by the next pass, nor by a later answer before they read it", async () => {
    await pass();
    await comms.reply(owner(), { id: pat.conversation, body: "Fourth answer." });
    expect(await texts("+15125550161")).toHaveLength(1);
  });
});

run("a notice that is no longer wanted when the hours end", () => {
  it("is dropped when the customer read the chat meanwhile, and says so", async () => {
    await quietHours(true);
    const una = await aChat("Una Cedar", "(512) 555-0162");
    await comms.reply(owner(), { id: una.conversation, body: "Answer for Una." });
    expect((await stateOf(una.conversation)).held).not.toBeNull();
    /** She opens the chat in the morning, before the worker comes round. */
    await portalChat.read(db(), { token: una.token });
    await quietHours(false);
    const results = await pass();
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ told: 0, dropped: 1 });
    expect(await texts("+15125550162")).toHaveLength(0);
    expect(await noticeOf(una.conversation)).toBe("Not told: they read the chat before your quiet hours ended.");
    expect((await stateOf(una.conversation)).held).toBeNull();
  });

  it("is dropped when the customer replied STOP meanwhile: consent is asked again at send time", async () => {
    await quietHours(true);
    const stan = await aChat("Stan Cedar", "(512) 555-0163");
    await comms.reply(owner(), { id: stan.conversation, body: "Answer for Stan." });
    await raw`insert into public.suppression (organization_id, address, channel, reason)
              values (${ORG}, '+15125550163', 'sms', 'stop')`;
    await quietHours(false);
    await pass();
    expect(await texts("+15125550163")).toHaveLength(0);
    expect(await noticeOf(stan.conversation)).toMatch(/^Not told\. Not texted: .*STOP.* Not emailed: no email address to write to\.$/);
    expect((await stateOf(stan.conversation)).held).toBeNull();
    /** Not tried again every pass. */
    await pass();
    expect(await texts("+15125550163")).toHaveLength(0);
  });

  it("is dropped when the company turned the notice off meanwhile", async () => {
    await quietHours(true);
    const olga = await aChat("Olga Cedar", "(512) 555-0164");
    await comms.reply(owner(), { id: olga.conversation, body: "Answer for Olga." });
    await portalSettings.set(owner(), { chatReplyNotice: false });
    await quietHours(false);
    await pass();
    await portalSettings.set(owner(), { chatReplyNotice: true });
    expect(await texts("+15125550164")).toHaveLength(0);
    expect(await noticeOf(olga.conversation)).toMatch(/turned off/);
    expect((await stateOf(olga.conversation)).held).toBeNull();
  });

  it("is dropped when it is more than two days old, because an answer that old is not news", async () => {
    await quietHours(true);
    const ola = await aChat("Ola Cedar", "(512) 555-0165");
    await comms.reply(owner(), { id: ola.conversation, body: "Answer for Ola." });
    await raw`update public.ai_chat_session set customer_notice_held_at = now() - interval '3 days'
      where conversation_id = ${ola.conversation}`;
    await quietHours(false);
    await pass();
    expect(await texts("+15125550165")).toHaveLength(0);
    expect(await noticeOf(ola.conversation)).toMatch(/more than two days/);
    expect((await stateOf(ola.conversation)).held).toBeNull();
  });
});

run("the worker's own pass", () => {
  it("sends a held notice with the others, once the hours have ended", async () => {
    await quietHours(true);
    const wes = await aChat("Wes Cedar", "(512) 555-0166");
    await comms.reply(owner(), { id: wes.conversation, body: "Answer for Wes." });
    await quietHours(false);
    const sentFor: string[] = [];
    await runPass({
      db: db(), chatNotices: { force: true }, geocoding: false, push: false,
      afterDrain: async (organizationId) => { sentFor.push(organizationId); },
    });
    expect(await texts("+15125550166")).toHaveLength(1);
    expect(sentFor).toContain(ORG);
    expect(await noticeOf(wes.conversation)).toBe("Told by text.");
  }, 60_000);

  it("reaches only the companies that have a notice waiting", async () => {
    await quietHours(true);
    const wen = await aChat("Wen Cedar", "(512) 555-0167");
    await comms.reply(owner(), { id: wen.conversation, body: "Answer for Wen." });
    const rows = await raw<{ organization_id: string }[]>`select organization_id from app.held_chat_notice_organizations(500)`;
    expect(rows.map((r) => r.organization_id)).toContain(ORG);
    await quietHours(false);
    await pass();
    const after = await raw<{ organization_id: string }[]>`select organization_id from app.held_chat_notice_organizations(500)`;
    expect(after.map((r) => r.organization_id)).not.toContain(ORG);
  });
});
