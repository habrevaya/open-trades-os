import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { agents as coreAgents, time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as comms from "../src/services/comms";
import * as contacts from "../src/services/contacts";
import * as customers from "../src/services/customers";
import * as portal from "../src/services/portal";
import * as portalAccess from "../src/services/portal-access";
import * as portalChat from "../src/services/portal-chat";
import * as portalNotice from "../src/services/portal-chat-notice";
import * as portalSignIn from "../src/services/portal-sign-in";
import "../src/ai/index";
import type { AiProvider, CompletionOutcome, ModelListOutcome, ModelRate } from "../src/ai/provider";
import { InvalidGrantError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CUSTOMER CLOSES THEIR CHAT (M05)
 *
 * A chat from a customer's account used to go on for ever: there was no way
 * to end it, and everything the customer had ever said sat in one thread.
 * Closing ends that conversation. The inbox shows it as closed and says the
 * customer closed it, the office cannot reply into it, nothing the office has
 * not read is hidden, and the next message the customer writes opens a new
 * conversation. Only a sign in can close it, and only its own.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-chat-close:org");
const USER = fixtureId("portal-chat-close:user");
const SLUG = "chat-close-co";
const ZONE = "America/Chicago";
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@chat-close.test`;
const EVE = `eve.${RUN}@chat-close.test`;
const SAM = `sam.${RUN}@chat-close.test`;
const NED = `ned.${RUN}@chat-close.test`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A model that answers every message the same way, so the assistant case has something to say. */
let asked = 0;
const friendlyModel: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(request): Promise<CompletionOutcome> {
    asked += 1;
    return {
      ok: true,
      completion: {
        model: request.model, content: [{ type: "text", text: "Happy to help." }], stop: "end",
        usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: null },
      },
    };
  },
  async models(): Promise<ModelListOutcome> { return { ok: true, models: [{ id: "fake-model", label: "Fake" }] }; },
};
const deps = (): ai.AiDeps => ({
  readSecret: async () => "sk-test-not-a-key", provider: friendlyModel,
  now: () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE),
});

let ipSeq = 0;
const ip = () => `198.19.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

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

/** Every portal chat conversation of a customer, newest first. */
const conversationsOf = (customerId: string) => raw<{ id: string; status: string; unread_count: number }[]>`
  select id, status::text as status, unread_count from public.conversation
  where organization_id = ${ORG} and customer_id = ${customerId} and external_address like 'portal:%'
  order by created_at desc`;

const rateLimitsReset = () => raw`delete from public.public_rate_limit where key like ${'%' + ORG + '%'}`;

const chatRow = async (conversationId: string) => (await raw<{
  status: string; customer_closed_at: Date | null; customer_notice: string | null; customer_notice_held_at: Date | null;
}[]>`select status::text as status, customer_closed_at, customer_notice, customer_notice_held_at
     from public.ai_chat_session where conversation_id = ${conversationId}`)[0]!;

let dana = "";
let eve = "";
let danaToken = "";
let eveToken = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cedar Heating", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@chat-close.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, '+15125559968', 'main', true)`;
  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  dana = await aCustomer("Dana Cedar", DANA);
  eve = await aCustomer("Eve Cedar", EVE);
  danaToken = await signIn(DANA);
  eveToken = await signIn(EVE);
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await rateLimitsReset();
  await resetOrg(raw, ORG);
  await raw.end();
});

run("closing the chat", () => {
  let first = "";

  it("shows the customer a closed, empty chat and closes the conversation in the inbox", async () => {
    await portalChat.say(db(), { token: danaToken, text: "The furnace is out" }, { ip: ip() }, deps());
    [first] = (await conversationsOf(dana)).map((c) => c.id);
    const closed = await portalChat.close(db(), { token: danaToken });
    expect(closed).toMatchObject({ status: "closed", messages: [], bookingTaken: false });
    expect((await portalChat.read(db(), { token: danaToken })).status).toBe("closed");

    const [conversation] = await conversationsOf(dana);
    expect(conversation).toMatchObject({ id: first, status: "closed" });
    const chat = await chatRow(first);
    expect(chat.status).toBe("closed");
    expect(chat.customer_closed_at).not.toBeNull();
  });

  it("is seen by the office as closed by the customer, with nowhere to reply", async () => {
    const thread = await comms.thread(owner(), { id: first });
    expect(thread.customerClosedAt).toBeInstanceOf(Date);
    expect(thread.conversation.status).toBe("closed");
    expect(thread.canReply).toBe(false);
    expect(thread.blockedReason).toBe("chat_closed");
    expect(thread.blockedExplanation).toBe("The customer closed this chat, so a reply has nowhere to go. If they write again, it opens a new one.");
    await expect(comms.reply(owner(), { id: first, body: "Are you there?" })).rejects.toThrow(/closed this chat/);

    const handled = await comms.handlers.getConversation(owner(), { id: first });
    expect(handled.customerClosedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const list = await comms.threads(owner(), { status: "closed", customerId: dana });
    expect(list.data.find((t) => t.id === first)).toMatchObject({ status: "closed", closedByCustomer: true });
    const all = await comms.threads(owner(), { customerId: dana });
    expect(all.data.find((t) => t.id === first)?.closedByCustomer).toBe(true);
  });

  it("is on the audit log as the sign in that closed it", async () => {
    const [line] = await raw<{ actor_user_id: string | null; actor_portal_grant_id: string | null; after: { status: string } }[]>`
      select actor_user_id, actor_portal_grant_id, after from public.audit_log
      where organization_id = ${ORG} and entity_id = ${first} and action = 'portal.chat_closed'`;
    expect(line).toBeTruthy();
    expect(line!.actor_user_id).toBeNull();
    expect(line!.actor_portal_grant_id).not.toBeNull();
    expect(line!.after).toEqual({ status: "closed" });
  });

  it("hides nothing from the office: what the customer wrote is still unread and its task still open", async () => {
    const [conversation] = await conversationsOf(dana);
    expect(conversation!.unread_count).toBeGreaterThan(0);
    const [task] = await raw<{ title: string; status: string }[]>`
      select title, status::text as status from public.task where organization_id = ${ORG} and entity_id = ${first}`;
    expect(task).toBeTruthy();
    expect(task!.status).not.toBe("done");
    const thread = await comms.threads(owner(), { customerId: dana });
    expect(thread.data.find((t) => t.id === first)?.awaitingReply).toBe(true);
  });

  it("changes nothing when it is closed again, or before there was a chat", async () => {
    const before = await chatRow(first);
    expect(await portalChat.close(db(), { token: danaToken })).toMatchObject({ status: "closed" });
    const after = await chatRow(first);
    expect(after.customer_closed_at!.getTime()).toBe(before.customer_closed_at!.getTime());

    const none = await portalChat.close(db(), { token: eveToken });
    expect(none).toEqual({ assistant: false, status: null, bookingTaken: false, messages: [] });
    expect(await conversationsOf(eve)).toHaveLength(0);
  });

  it("opens a new conversation when the customer writes again, and leaves the closed one as it was", async () => {
    await rateLimitsReset();
    const wrote = await portalChat.say(db(), { token: danaToken, text: "It is back on, thank you" }, { ip: ip() }, deps());
    expect(wrote.status).toBe("handed_off");
    expect(wrote.messages.map((m) => m.text)).toEqual(["It is back on, thank you"]);
    const [newest, older] = await conversationsOf(dana);
    expect(newest!.id).not.toBe(first);
    expect(newest!.status).toBe("open");
    expect(older).toMatchObject({ id: first, status: "closed" });
    expect((await chatRow(first)).status).toBe("closed");
    expect((await comms.thread(owner(), { id: first })).messages).toHaveLength(1);
    expect((await comms.thread(owner(), { id: newest!.id })).customerClosedAt).toBeNull();
    /** The office can answer the new one. */
    expect((await comms.thread(owner(), { id: newest!.id })).canReply).toBe(true);
    await comms.reply(owner(), { id: newest!.id, body: "Glad to hear it." });
    expect((await portalChat.read(db(), { token: danaToken })).messages.map((m) => m.text)).toEqual(["It is back on, thank you", "Glad to hear it."]);
  });

  it("can be closed again, and the account page counts nothing from the closed one", async () => {
    await portalChat.close(db(), { token: danaToken });
    expect((await portalChat.unreadReplies(db(), { token: danaToken })).unread).toBe(0);
    expect(await conversationsOf(dana)).toHaveLength(2);
  });
});

run("only the customer's own sign in closes their chat", () => {
  it("never reaches another customer's chat", async () => {
    await rateLimitsReset();
    await portalChat.say(db(), { token: eveToken, text: "Hello, it is Eve" }, { ip: ip() }, deps());
    await portalChat.say(db(), { token: danaToken, text: "Dana again" }, { ip: ip() }, deps());
    await portalChat.close(db(), { token: danaToken });
    const [eves] = await conversationsOf(eve);
    expect(eves!.status).toBe("open");
    expect((await portalChat.read(db(), { token: eveToken })).status).toBe("handed_off");
  });

  it("is refused for an account link, which is not a sign in", async () => {
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: dana, scope: "customer", expiresInDays: 30,
    }));
    await expect(portalChat.close(db(), { token: link.token })).rejects.toThrow(InvalidGrantError);
    await expect(portalChat.close(db(), { token: "x".repeat(40) })).rejects.toThrow(InvalidGrantError);
  });

  it("closes a contact's own chat and names the contact on the audit line", async () => {
    const sam = await contacts.create(owner(), { name: "Sam Cedar", customerId: dana, email: SAM, preferredChannel: "email" });
    await portalAccess.setContactAccess(owner(), { id: sam.id, allowed: true });
    const samToken = await signIn(SAM);
    await portalChat.say(db(), { token: samToken, text: "It is Sam" }, { ip: ip() }, deps());
    const [samsChat] = await raw<{ id: string }[]>`
      select id from public.conversation where organization_id = ${ORG} and external_address = ${`portal:${dana}:${sam.id}`}`;
    /** Dana writes again, so she has a chat of her own open while Sam closes his. */
    await portalChat.say(db(), { token: danaToken, text: "Dana here, still open" }, { ip: ip() }, deps());
    await portalChat.close(db(), { token: samToken });
    expect((await chatRow(samsChat!.id)).status).toBe("closed");
    const [line] = await raw<{ actor_contact_id: string | null }[]>`
      select actor_contact_id from public.audit_log
      where organization_id = ${ORG} and entity_id = ${samsChat!.id} and action = 'portal.chat_closed'`;
    expect(line!.actor_contact_id).toBe(sam.id);
    /** Dana's own chat is not Sam's. */
    const [hers] = await raw<{ status: string }[]>`
      select status::text as status from public.conversation
      where organization_id = ${ORG} and external_address = ${`portal:${dana}`} order by created_at desc limit 1`;
    expect(hers!.status).toBe("open");
  });
});

run("the automated assistant", () => {
  it("stays out of a chat that was closed, and greets the customer afresh in the next", async () => {
    await agents.configure(owner(), {
      agent: "chat",
      settings: {
        ...coreAgents.defaultSettings("chat"), enabled: true, runAsUserId: USER,
        chat: { ...coreAgents.defaultSettings("chat").chat, portal: true },
      },
    });
    await rateLimitsReset();
    const ned = await aCustomer("Ned Cedar", NED);
    const nedToken = await signIn(NED);
    const opened = await portalChat.say(db(), { token: nedToken, text: "Do you do boilers?" }, { ip: ip() }, deps());
    expect(opened.messages.map((m) => m.from)).toEqual(["assistant", "assistant", "visitor", "assistant"]);
    const [firstChat] = await conversationsOf(ned);
    const answersBefore = asked;

    await portalChat.close(db(), { token: nedToken });
    expect((await portalChat.read(db(), { token: nedToken })).messages).toEqual([]);

    const again = await portalChat.say(db(), { token: nedToken, text: "Do you service heat pumps?" }, { ip: ip() }, deps());
    expect(asked).toBe(answersBefore + 1);
    expect(again.messages[0]).toMatchObject({ from: "assistant", text: expect.stringMatching(/automated assistant/) });
    expect(again.messages.map((m) => m.text)).not.toContain("Do you do boilers?");
    const [secondChat] = await conversationsOf(ned);
    expect(secondChat!.id).not.toBe(firstChat!.id);
    const [old] = await raw<{ n: number }[]>`select count(*)::int as n from public.message where conversation_id = ${firstChat!.id}`;
    expect(old!.n).toBe(4);
    await agents.configure(owner(), { agent: "chat", settings: { ...coreAgents.defaultSettings("chat"), enabled: false } });
  });
});

run("a notice that quiet hours were holding", () => {
  it("is dropped when the customer closes the chat, and the worker sends nothing", async () => {
    const ZED = `zed.${RUN}@chat-close.test`;
    const phone = "(512) 555-0171";
    const zed = await aCustomer("Zed Cedar", ZED, { phone });
    await contacts.create(owner(), { name: "Zed Cedar", customerId: zed, phone, email: ZED, preferredChannel: "sms", isPrimary: true });
    const zedToken = await signIn(ZED);
    await raw`update public.customer set email = null where id = ${zed}`;
    await raw`update public.contact set email = null where customer_id = ${zed}`;
    await rateLimitsReset();
    await portalChat.say(db(), { token: zedToken, text: "Anyone there?" }, { ip: ip() }, deps());
    const [chat] = await conversationsOf(zed);
    await raw`update public.message set created_at = created_at - interval '1 hour' where conversation_id = ${chat!.id}`;
    await raw`update public.ai_chat_session set customer_read_at = now() - interval '5 minutes' where conversation_id = ${chat!.id}`;
    const hour = Math.floor(time.minutesInDay(new Date(), ZONE) / 60);
    const quiet = (startHour: number, endHour: number) => raw`update public.organization
      set settings = coalesce(settings, '{}'::jsonb) || ${raw.json({ quietHours: { startHour, endHour } })} where id = ${ORG}`;
    await quiet(hour, (hour + 2) % 24);
    await comms.reply(owner(), { id: chat!.id, body: "On our way." });
    expect((await chatRow(chat!.id)).customer_notice_held_at).not.toBeNull();

    await portalChat.close(db(), { token: zedToken });
    const closed = await chatRow(chat!.id);
    expect(closed.customer_notice_held_at).toBeNull();
    expect(closed.customer_notice).toBe("Not told: the customer closed the chat.");

    await quiet((hour + 12) % 24, (hour + 13) % 24);
    await portalNotice.releasePass(db(), { force: true });
    const sent = await raw`select id from public.message
      where organization_id = ${ORG} and direction = 'outbound' and to_address = '+15125550171' and channel = 'sms'
        and body like '%answered your message%'`;
    expect(sent).toHaveLength(0);
  });

  it("is dropped by the worker for a chat found closed, whatever closed it", async () => {
    const YAN = `yan.${RUN}@chat-close.test`;
    const phone = "(512) 555-0172";
    const yan = await aCustomer("Yan Cedar", YAN, { phone });
    await contacts.create(owner(), { name: "Yan Cedar", customerId: yan, phone, email: YAN, preferredChannel: "sms", isPrimary: true });
    const yanToken = await signIn(YAN);
    await raw`update public.customer set email = null where id = ${yan}`;
    await raw`update public.contact set email = null where customer_id = ${yan}`;
    await rateLimitsReset();
    await portalChat.say(db(), { token: yanToken, text: "Hello" }, { ip: ip() }, deps());
    const [chat] = await conversationsOf(yan);
    await raw`update public.message set created_at = created_at - interval '1 hour' where conversation_id = ${chat!.id}`;
    await raw`update public.ai_chat_session set customer_read_at = now() - interval '5 minutes', customer_notice_held_at = now() - interval '1 hour', status = 'closed'
      where conversation_id = ${chat!.id}`;
    await raw`insert into public.message (organization_id, conversation_id, direction, channel, purpose, from_address, to_address, body, status, sent_by_user_id)
      values (${ORG}, ${chat!.id}, 'outbound', 'webchat', 'transactional', 'portal', ${`portal:${yan}`}, 'Hi', 'sent', ${USER})`;
    const results = await portalNotice.releasePass(db(), { force: true });
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ told: 0, dropped: 1 });
    expect((await chatRow(chat!.id)).customer_notice).toBe("Not told: the customer closed the chat.");
  });
});
