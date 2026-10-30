import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { PermissionError, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import * as comms from "../src/services/comms";
import * as customers from "../src/services/customers";
import * as portalChat from "../src/services/portal-chat";
import * as portalSettings from "../src/services/portal-settings";
import * as portalSignIn from "../src/services/portal-sign-in";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE OFFICE CLOSES A CHAT, AND A CHAT THAT WENT QUIET CLOSES ITSELF (M05)
 *
 * The customer could always close their chat; the office had no button, and a
 * chat nobody closed stayed open for good. Now a person closes it from the
 * inbox, and a company can choose a number of quiet days. Either way the
 * customer's page says in words that the company closed it and still shows
 * what was said, nothing the office has not read is hidden, and the next thing
 * the customer writes opens a new conversation. A chat the customer wrote last
 * in is never closed for being quiet.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const ORG = fixtureId("portal-chat-office-close:org");
const USER = fixtureId("portal-chat-office-close:user");
const SLUG = "chat-office-close-co";
const ZONE = "America/Chicago";
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@chat-office-close.test`;

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
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@chat-office-close.test" })})`;
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

run("a person closes the chat from the inbox", () => {
  it("closes the conversation, records who and when, and keeps what the office has not read in front of it", async () => {
    const id = await answeredChat("Please come before five");
    const closed = await portalChat.closeFromOffice(owner(), { id });
    expect(closed).toMatchObject({ id, closedBy: "office" });

    expect(await chatRow(id)).toMatchObject({
      status: "closed", office_close_kind: "office", office_closed_by_user_id: USER, customer_closed_at: null,
    });
    expect((await chatRow(id)).office_closed_at).not.toBeNull();
    const [conversation] = await raw<{ status: string; unread_count: number }[]>`
      select status::text as status, unread_count from public.conversation where id = ${id}`;
    expect(conversation).toMatchObject({ status: "closed" });
    // What the customer wrote is still unread: closing hides nothing from the office.
    const unread = await raw`select 1 from public.message where conversation_id = ${id} and direction = 'inbound' and read_at is null`;
    expect(unread).toHaveLength(1);

    const audited = await raw`
      select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${id} and action = 'portal.chat_closed_by_office'`;
    expect(audited).toHaveLength(1);

    const thread = await comms.thread(owner(), { id });
    expect(thread).toMatchObject({ closedBy: "office", canReply: false, blockedReason: "chat_closed" });
    expect(thread.officeClosedAt).toBeInstanceOf(Date);
    expect(thread.blockedExplanation).toMatch(/This chat was closed/);
    await expect(comms.reply(owner(), { id, body: "One more thing" })).rejects.toThrow(ConflictError);
  });

  it("is the list's closed chat, said by who closed it", async () => {
    const id = await answeredChat();
    await portalChat.closeFromOffice(owner(), { id });
    const list = await comms.threads(owner(), { status: "closed" });
    expect(list.data.find((t) => t.id === id)).toMatchObject({ status: "closed", closedBy: "office", closedByCustomer: false });
  });

  it("tells the customer in words on their page, and still shows them what was said", async () => {
    const id = await answeredChat();
    await portalChat.closeFromOffice(owner(), { id });
    const seen = await portalChat.read(db(), { token });
    expect(seen).toMatchObject({ status: "closed", closedBy: "office" });
    expect(seen.messages.map((m) => m.text)).toEqual(expect.arrayContaining(["The furnace is out", "Looking now."]));
    // They have now read the answer that came just before the close.
    expect((await portalChat.unreadReplies(db(), { token })).unread).toBe(0);
  });

  it("opens a new conversation when the customer writes again, leaving the closed one as it was", async () => {
    const id = await answeredChat();
    await portalChat.closeFromOffice(owner(), { id });
    const view = await portalChat.say(db(), { token, text: "Still cold" }, { ip: ip() });
    expect(view.status).not.toBe("closed");
    expect(view.messages.map((m) => m.text)).toEqual(["Still cold"]);
    const [newest, oldest] = await chatsOf();
    expect(newest!.id).not.toBe(id);
    expect(oldest).toMatchObject({ id, status: "closed" });
  });

  it("is the same close when asked twice, and a customer's own close is left as theirs", async () => {
    const id = await answeredChat();
    const first = await portalChat.closeFromOffice(owner(), { id });
    const second = await portalChat.closeFromOffice(owner(), { id });
    expect(second).toEqual(first);
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'portal.chat_closed_by_office'`).toHaveLength(1);

    await portalChat.say(db(), { token, text: "Hello again" }, { ip: ip() });
    const byThem = (await chatsOf())[0]!.id;
    await portalChat.close(db(), { token });
    const answered = await portalChat.closeFromOffice(owner(), { id: byThem });
    expect(answered.closedBy).toBe("customer");
    expect((await chatRow(byThem)).office_closed_at).toBeNull();
  });

  it("is for somebody who may send, in the conversations they may see, and for an account chat only", async () => {
    const id = await answeredChat();
    await expect(portalChat.closeFromOffice(as("accountant"), { id })).rejects.toThrow(PermissionError);
    await expect(portalChat.closeFromOffice(owner(), { id: fixtureId("portal-chat-office-close:nothing") }))
      .rejects.toThrow(NotFoundError);
    const [text] = await raw<{ id: string }[]>`
      insert into public.conversation (organization_id, channel, external_address, internal_address, status, customer_id)
      values (${ORG}, 'sms', '+15125550188', '+15125559968', 'open', ${dana}) returning id`;
    await expect(portalChat.closeFromOffice(owner(), { id: text!.id })).rejects.toThrow(/account/);
    expect((await chatRow(id)).status).not.toBe("closed");
  });

  it("still sends a notice that quiet hours were holding, since the link shows the answer", async () => {
    const id = await answeredChat();
    await raw`update public.ai_chat_session set customer_notice_held_at = now() where conversation_id = ${id}`;
    await portalChat.closeFromOffice(owner(), { id });
    expect((await chatRow(id)).customer_notice_held_at).not.toBeNull();
  });
});

run("the company's rule for a chat that went quiet", () => {
  const turnOn = (days: number | null) => portalSettings.set(owner(), { chatIdleCloseDays: days });

  it("is off until the company chooses, and closes nothing while it is", async () => {
    expect((await portalSettings.get(owner())).chatIdleCloseDays).toBeNull();
    const id = await answeredChat();
    await ageChat(id, 30);
    expect(await quietPass()).toEqual([]);
    expect((await chatRow(id)).status).not.toBe("closed");
  });

  it("reads back what was set, keeps the other portal settings, and refuses a number out of range", async () => {
    await portalSettings.set(owner(), { bankAccounts: true });
    expect((await turnOn(7)).chatIdleCloseDays).toBe(7);
    expect((await portalSettings.get(owner())).bankAccounts).toBe(true);
    await expect(turnOn(0)).rejects.toThrow(/whole number from 1 to 90/);
    await expect(turnOn(91)).rejects.toBeInstanceOf(ConflictError);
    await expect(turnOn(2.5)).rejects.toBeInstanceOf(ConflictError);
    expect((await portalSettings.get(owner())).chatIdleCloseDays).toBe(7);
    expect((await turnOn(null)).chatIdleCloseDays).toBeNull();
    expect((await portalSettings.get(owner())).bankAccounts).toBe(true);
    await expect(portalSettings.set(as("technician"), { chatIdleCloseDays: 3 })).rejects.toThrow(PermissionError);
  });

  it("closes a chat the company answered last once the customer has been quiet that many days", async () => {
    await turnOn(3);
    const id = await answeredChat();
    await ageChat(id, 5);
    expect(await quietPass()).toEqual([id]);

    expect(await chatRow(id)).toMatchObject({ status: "closed", office_close_kind: "idle", office_closed_by_user_id: null });
    const thread = await comms.thread(owner(), { id });
    expect(thread).toMatchObject({ closedBy: "idle", closedByName: null, canReply: false });
    expect(thread.blockedExplanation).toMatch(/went quiet/);
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'portal.chat_closed_idle'`).toHaveLength(1);
    // What the customer wrote still waits for a person.
    expect(await raw`select 1 from public.message where conversation_id = ${id} and direction = 'inbound' and read_at is null`)
      .toHaveLength(1);

    const seen = await portalChat.read(db(), { token });
    expect(seen).toMatchObject({ status: "closed", closedBy: "idle" });
    expect(seen.messages.length).toBeGreaterThan(0);
    // Closing it once is closing it: a second pass finds nothing.
    expect(await quietPass()).toEqual([]);
  });

  it("counts the company's calendar days, and leaves a chat that is not quiet enough alone", async () => {
    await turnOn(3);
    const fresh = await answeredChat("Fresh one");
    await ageChat(fresh, 1);
    expect(await quietPass()).toEqual([]);
    await ageChat(fresh, 1);
    expect(await quietPass()).toEqual([]);
    await ageChat(fresh, 1);
    expect(await quietPass()).toEqual([fresh]);
  });

  it("never closes a chat the customer wrote last in, however old, because they are waiting for an answer", async () => {
    await turnOn(1);
    await portalChat.say(db(), { token, text: "Is anyone there?" }, { ip: ip() });
    const waiting = (await chatsOf())[0]!.id;
    await ageChat(waiting, 40);
    expect(await quietPass()).toEqual([]);
    expect((await chatRow(waiting)).status).not.toBe("closed");
  });

  it("only closes a chat the company has answered, in the company that chose it", async () => {
    const id = await answeredChat();
    await ageChat(id, 10);
    const listed = () => raw<{ organization_id: string }[]>`select organization_id from app.portal_chat_idle_organizations(500)`;
    expect((await listed()).map((r) => r.organization_id)).not.toContain(ORG);
    await turnOn(2);
    expect((await listed()).map((r) => r.organization_id)).toContain(ORG);
    // The all-company pass is not run here: files run side by side, and it would close other files' chats.
    expect(await quietPass()).toEqual([id]);
    await turnOn(2);
    expect((await listed()).map((r) => r.organization_id)).not.toContain(ORG);
  });

  it("does not text or email the customer about it", async () => {
    await turnOn(1);
    const id = await answeredChat();
    const before = await raw`select 1 from public.message where organization_id = ${ORG} and direction = 'outbound' and conversation_id <> ${id}`;
    await ageChat(id, 4);
    await quietPass();
    const after = await raw`select 1 from public.message where organization_id = ${ORG} and direction = 'outbound' and conversation_id <> ${id}`;
    expect(after).toHaveLength(before.length);
  });
});
