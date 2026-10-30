import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { PermissionError, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import * as comms from "../src/services/comms";
import * as conversationClose from "../src/services/conversation-close";
import * as customers from "../src/services/customers";
import * as portalChat from "../src/services/portal-chat";
import * as portalSettings from "../src/services/portal-settings";
import * as portalSignIn from "../src/services/portal-sign-in";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * CLOSE AND REOPEN ANY CONVERSATION (M05, M18)
 *
 * A person closes a website visitor's chat, a text thread or an email thread as
 * well as a customer's account chat, and reopens any closed one. It is the same
 * conversation both ways, the inbox says who closed it, and a chat the quiet
 * chat rule closed is not closed again within the minute it is reopened.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const ORG = fixtureId("conversation-close:org");
const USER = fixtureId("conversation-close:user");
const SLUG = "conversation-close-co";
const ZONE = "America/Chicago";
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@conversation-close.test`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

let ipSeq = 0;
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

let dana = "";
let token = "";

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

const rateLimitsReset = () => raw`delete from public.public_rate_limit where key like ${'%' + ORG + '%'}`;

const chatsOf = () => raw<{ id: string; status: string }[]>`
  select id, status::text as status from public.conversation
   where organization_id = ${ORG} and customer_id = ${dana} and external_address like 'portal:%'
   order by created_at desc`;

const chatRow = async (conversationId: string) => (await raw<{
  status: string; office_closed_at: Date | null; office_closed_by_user_id: string | null; office_close_kind: string | null;
  customer_closed_at: Date | null; customer_notice_held_at: Date | null;
}[]>`select status::text as status, office_closed_at, office_closed_by_user_id, office_close_kind,
            customer_closed_at, customer_notice_held_at
       from public.ai_chat_session where conversation_id = ${conversationId}`)[0]!;

/** The customer writes and the office answers: the chat the company wrote last in. */
async function answeredChat(text = "The furnace is out"): Promise<string> {
  await portalChat.say(db(), { token, text }, { ip: ip() });
  const id = (await chatsOf())[0]!.id;
  await comms.reply(owner(), { id, body: "Looking now." });
  return id;
}

/** Make the last message of a chat, whoever wrote it, `days` days old. */
const ageChat = (conversationId: string, days: number) => raw`
  update public.message set created_at = created_at - (${days} || ' days')::interval, updated_at = now()
   where conversation_id = ${conversationId}`;

const workerCtx = (): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId: ORG, roles: [], grants: [], agentId: "portal-chat-idle" }, db: db(),
});
const quietPass = (now = new Date()) => inTenant(workerCtx(), (tx) => portalChat.closeIdleIn(tx, workerCtx(), now));

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cedar Heating", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@chat-conversation-close.test" })})`;
  const c = await customers.create(owner(), {
    type: "residential", name: "Dana Cedar", email: DANA, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  dana = c.id as string;
  token = await signIn(DANA);
});

afterAll(async () => {
  if (!raw) return;
  await rateLimitsReset();
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await rateLimitsReset();
  // Every chat from an earlier test is closed, so each test starts with the customer having none open.
  await raw`update public.ai_chat_session set status = 'closed' where organization_id = ${ORG}`;
  await raw`update public.conversation set status = 'closed' where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'portal' where id = ${ORG}`;
});


const CUSTOMER_PHONE = "+15125550143";
const OUR_NUMBER = "+15125550101";
const MAIL = "pat@conversation-close.test";

/** A thread with messages in it, by raw insert: text, email or a website chat. */
async function thread(channel: "sms" | "email" | "webchat", opts: { chat?: "open" | "handed_off" } = {}): Promise<string> {
  const address = channel === "sms" ? CUSTOMER_PHONE : channel === "email" ? MAIL : `visitor-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.conversation (organization_id, channel, external_address, internal_address, status, customer_id, last_message_at, unread_count)
    values (${ORG}, ${channel}, ${address}, ${channel === "webchat" ? "website" : null}, 'open', ${dana}, now(), 1) returning id`;
  await raw`insert into public.message (organization_id, conversation_id, direction, channel, purpose, from_address, to_address, body, status)
    values (${ORG}, ${c!.id}, 'inbound', ${channel}, 'transactional', ${address}, 'us', 'Can you come Friday?', 'received'),
           (${ORG}, ${c!.id}, 'outbound', ${channel}, 'transactional', 'us', ${address}, 'Let me check.', 'sent')`;
  if (channel === "webchat") {
    await raw`insert into public.ai_chat_session (organization_id, conversation_id, channel, status, handed_off_at)
      values (${ORG}, ${c!.id}, 'web', ${opts.chat ?? "open"}::ai_chat_status, ${opts.chat === "handed_off" ? new Date() : null})`;
  }
  return c!.id;
}

const conversationRow = async (id: string) => (await raw<{
  status: string; closed_at: Date | null; closed_by_user_id: string | null; reopened_at: Date | null;
  reopened_by_user_id: string | null; unread_count: number;
}[]>`select status::text as status, closed_at, closed_by_user_id, reopened_at, reopened_by_user_id, unread_count
       from public.conversation where id = ${id}`)[0]!;
const messageCount = async (id: string) => (await raw`select 1 from public.message where conversation_id = ${id}`).length;

run("closing a text or an email thread", () => {
  it.each(["sms", "email"] as const)("closes a %s thread: who and when are kept, nothing is lost, and the customer is told nothing", async (channel) => {
    const id = await thread(channel);
    const sentBefore = (await raw`select 1 from public.message where organization_id = ${ORG} and direction = 'outbound'`).length;
    const closed = await conversationClose.close(owner(), { id });
    expect(closed).toMatchObject({ id, closedBy: "office", closedByName: expect.any(String) });
    expect(await conversationRow(id)).toMatchObject({ status: "closed", closed_by_user_id: USER, unread_count: 1 });
    expect(await messageCount(id)).toBe(2);
    expect((await raw`select 1 from public.message where organization_id = ${ORG} and direction = 'outbound'`).length).toBe(sentBefore);
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'conversation.closed_by_office'`).toHaveLength(1);

    const view = await comms.thread(owner(), { id });
    expect(view).toMatchObject({ closedBy: "office", closedByName: closed.closedByName, customerClosedAt: null });
    expect(view.closedAt).toBeInstanceOf(Date);
    const list = await comms.threads(owner(), { status: "closed" });
    expect(list.data.find((t) => t.id === id)).toMatchObject({ status: "closed", closedBy: "office", closedByName: closed.closedByName, closedByCustomer: false });
  });

  it("is the same close asked twice", async () => {
    const id = await thread("sms");
    const first = await conversationClose.close(owner(), { id });
    const second = await conversationClose.close(owner(), { id });
    expect(second).toEqual(first);
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'conversation.closed_by_office'`).toHaveLength(1);
  });

  it("opens again by itself when the office answers, as it always did, and says nothing of the old close", async () => {
    await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered) values (${ORG}, ${OUR_NUMBER}, 'main', true)
      on conflict do nothing`;
    const id = await thread("sms");
    await conversationClose.close(owner(), { id });
    await comms.reply(owner(), { id, body: "Friday works." });
    expect((await conversationRow(id)).status).toBe("open");
    const view = await comms.thread(owner(), { id });
    expect(view).toMatchObject({ closedBy: null, closedAt: null, officeClosedAt: null });
  });
});

run("closing a website chat", () => {
  it("ends it: a reply is refused in words, and who closed it is kept on the chat and the conversation", async () => {
    const id = await thread("webchat", { chat: "handed_off" });
    const closed = await conversationClose.close(owner(), { id });
    expect(closed.closedBy).toBe("office");
    expect((await raw`select status::text as s, office_closed_by_user_id as u, office_close_kind as k from public.ai_chat_session where conversation_id = ${id}`)[0])
      .toMatchObject({ s: "closed", u: USER, k: "office" });
    const view = await comms.thread(owner(), { id });
    expect(view).toMatchObject({ canReply: false, blockedReason: "chat_closed", closedBy: "office" });
    expect(view.blockedExplanation).toMatch(/website chat has ended.*Reopen/);
    await expect(comms.reply(owner(), { id, body: "Hello?" })).rejects.toThrow(ConflictError);
  });
});

run("reopening", () => {
  it.each(["sms", "email", "webchat"] as const)("brings a closed %s conversation back as the same thread, and says who did", async (channel) => {
    const id = await thread(channel, { chat: "handed_off" });
    await conversationClose.close(owner(), { id });
    const back = await conversationClose.reopen(owner(), { id });
    expect(back).toMatchObject({ id, status: "open", previouslyClosedBy: "office" });
    expect(await conversationRow(id)).toMatchObject({ status: "open", reopened_by_user_id: USER });
    expect((await conversationRow(id)).reopened_at).not.toBeNull();
    expect(await messageCount(id)).toBe(2);
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'conversation.reopened'`).toHaveLength(1);
    const view = await comms.thread(owner(), { id });
    expect(view).toMatchObject({ closedBy: null, reopenedByName: expect.any(String) });
    if (channel === "webchat") {
      // Back with the person who had it, and the chat takes a reply again.
      expect((await raw`select status::text as s, office_closed_at as c from public.ai_chat_session where conversation_id = ${id}`)[0])
        .toMatchObject({ s: "handed_off", c: null });
      expect(view.canReply).toBe(true);
    }
  });

  it("puts a chat that had no person back open, not with one", async () => {
    const id = await thread("webchat", { chat: "open" });
    await conversationClose.close(owner(), { id });
    await conversationClose.reopen(owner(), { id });
    expect((await raw`select status::text as s from public.ai_chat_session where conversation_id = ${id}`)[0]!.s).toBe("open");
  });

  it("is the same reopen asked twice, and nothing to do for one that is open", async () => {
    const id = await thread("email");
    expect(await conversationClose.reopen(owner(), { id })).toMatchObject({ status: "open", previouslyClosedBy: null, reopenedAt: null });
    await conversationClose.close(owner(), { id });
    const first = await conversationClose.reopen(owner(), { id });
    const second = await conversationClose.reopen(owner(), { id });
    expect(second.previouslyClosedBy).toBeNull();
    expect(second.reopenedAt).toBe(first.reopenedAt);
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'conversation.reopened'`).toHaveLength(1);
  });

  it("reopens an account chat the customer closed, and the chat is back for both of them", async () => {
    await portalChat.say(db(), { token, text: "Never mind the furnace" }, { ip: ip() });
    const id = (await chatsOf())[0]!.id;
    await portalChat.close(db(), { token });
    expect((await comms.thread(owner(), { id })).closedBy).toBe("customer");
    const back = await conversationClose.reopen(owner(), { id });
    expect(back.previouslyClosedBy).toBe("customer");
    expect(await chatRow(id)).toMatchObject({ status: "handed_off", customer_closed_at: null });
    const view = await comms.thread(owner(), { id });
    expect(view).toMatchObject({ closedBy: null, customerClosedAt: null, canReply: true });
    // The customer's page shows the chat again, with what was said.
    const seen = await portalChat.read(db(), { token });
    expect(seen.status).not.toBe("closed");
    expect(seen.messages.length).toBeGreaterThan(0);
  });

  it("reopens an account chat the company closed, keeping the thread, and it takes the customer's next message", async () => {
    const id = await answeredChat();
    const before = (await chatsOf()).length;
    await conversationClose.close(owner(), { id });
    await conversationClose.reopen(owner(), { id });
    await portalChat.say(db(), { token, text: "Thanks, one more thing" }, { ip: ip() });
    expect((await chatsOf())[0]!.id).toBe(id);
    expect(await chatsOf()).toHaveLength(before);
  });

  it("leaves a reopened chat alone when the quiet chat rule would close it, until it has been quiet again", async () => {
    await portalSettings.set(owner(), { chatIdleCloseDays: 3 });
    const id = await answeredChat();
    await ageChat(id, 6);
    expect(await quietPass()).toEqual([id]);
    await conversationClose.reopen(owner(), { id });
    expect(await quietPass()).toEqual([]);
    expect((await chatRow(id)).status).not.toBe("closed");
    // Quiet again for the whole time since it was reopened: closed again.
    await raw`update public.conversation set reopened_at = now() - interval '6 days' where id = ${id}`;
    expect(await quietPass()).toEqual([id]);
  });

  it("refuses a thread marked as spam, in words, and changes nothing", async () => {
    const id = await thread("sms");
    await raw`update public.conversation set status = 'spam' where id = ${id}`;
    await expect(conversationClose.close(owner(), { id })).rejects.toThrow(/spam/);
    await expect(conversationClose.reopen(owner(), { id })).rejects.toThrow(/spam/);
    expect((await conversationRow(id)).status).toBe("spam");
  });
});

run("who may", () => {
  it("is for somebody who may send, in the conversations they may see", async () => {
    const id = await thread("sms");
    await expect(conversationClose.close(as("accountant"), { id })).rejects.toThrow(PermissionError);
    await expect(conversationClose.reopen(as("accountant"), { id })).rejects.toThrow(PermissionError);
    await expect(conversationClose.close(owner(), { id: fixtureId("conversation-close:nothing") })).rejects.toThrow(NotFoundError);
    await expect(conversationClose.reopen(owner(), { id: fixtureId("conversation-close:nothing") })).rejects.toThrow(NotFoundError);
    expect((await conversationRow(id)).status).toBe("open");
  });
});
