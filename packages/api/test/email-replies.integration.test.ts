import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as email from "../src/services/email";
import * as emailInbound from "../src/services/email-inbound";
import * as comms from "../src/services/comms";
import { svixSignature } from "../src/email/resend";
import "../src/email";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A CUSTOMER REPLIES TO AN EMAIL, AND THE OFFICE SEES IT
 *
 * An invoice goes out with the thread's reply address on it, the customer
 * presses reply, Resend receives the mail and posts it to the webhook,
 * signed, and it lands in the thread the invoice is in, with the quoted
 * invoice cut off. The office answers from the inbox and the answer goes out
 * by email with the same reply address. A forged post is refused, a retried
 * one is stored once, an out of office announces nothing, and somebody
 * writing to the reply address fresh starts a thread of their own.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("email-replies:org");
const USER = fixtureId("email-replies:user");
const FROM = "office@replies-co.example";
const DOMAIN = "replies.replies-co.example";
const CUSTOMER = "jo@customer.example";
const TOKEN = "e".repeat(20) + randomBytes(12).toString("hex");
const SECRET = `whsec_${Buffer.from("resend-signing-key-for-replies").toString("base64")}`;
const secrets: Record<string, string> = { RESEND_HOOK: SECRET, RESEND_KEY: "re_test_key" };
const readSecret = async (ref: string) => {
  const value = secrets[ref];
  if (!value) throw new Error(`no secret ${ref}`);
  return value;
};

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

let sequence = 0;
function post(data: Record<string, unknown>, options: { forge?: boolean } = {}) {
  const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data });
  sequence += 1;
  const id = `msg_${sequence}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = svixSignature(SECRET, id, timestamp, options.forge ? `${body} ` : body);
  return emailInbound.receiveByToken(db(), {
    token: TOKEN,
    url: `https://ots.test/api/webhooks/email/${TOKEN}`,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    rawBody: body,
  }, readSecret);
}

let invoiceThread = "";
let replyTo = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Replies Co", slug: "replies-co" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'email', 'resend', 'connected', 'RESEND_KEY',
                    ${raw.json({
                      fromAddress: FROM, replyDomain: DOMAIN, webhookToken: TOKEN, webhookSecretRef: "RESEND_HOOK",
                      baseUrl: "http://127.0.0.1:9",
                    })})`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("an email that can be replied to", () => {
  it("goes out with its thread's own reply address", async () => {
    const queued = await email.queue(owner(), { to: CUSTOMER, subject: "Invoice 1042", text: "Your invoice is attached." });
    if (!queued.queued) throw new Error(queued.explanation);
    invoiceThread = queued.conversationId;
    const [message] = await raw<{ headers: Record<string, string> }[]>`select headers from public.message where id = ${queued.messageId}`;
    replyTo = message!.headers["Reply-To"]!;
    const [conversation] = await raw<{ reply_token: string }[]>`select reply_token from public.conversation where id = ${invoiceThread}`;
    expect(replyTo).toBe(`reply+${conversation!.reply_token}@${DOMAIN}`);
    expect(conversation!.reply_token.length).toBeGreaterThanOrEqual(32);
  });

  it("keeps a Reply-To the caller chose", async () => {
    const queued = await email.queue(owner(), {
      to: "other@customer.example", subject: "Hello", text: "Hi.", replyTo: "dana@replies-co.example",
    });
    if (!queued.queued) throw new Error(queued.explanation);
    const [message] = await raw<{ headers: Record<string, string> }[]>`select headers from public.message where id = ${queued.messageId}`;
    expect(message!.headers["Reply-To"]).toBe("dana@replies-co.example");
  });
});

run("the reply coming back", () => {
  it("refuses a post the provider did not sign, and stores nothing", async () => {
    const outcome = await post({
      email_id: "in_forged", from: CUSTOMER, to: [replyTo], subject: "Re: Invoice 1042", text: "Cancel everything.",
    }, { forge: true });
    expect(outcome).toEqual({ kind: "rejected", reason: "bad_signature" });
    const stored = await raw`select 1 from public.message where provider_message_id = 'in_forged'`;
    expect(stored).toHaveLength(0);
  });

  it("lands the reply in the thread it answers, with the quoted email cut off", async () => {
    const outcome = await post({
      email_id: "in_1", from: `Jo Customer <${CUSTOMER}>`, to: [replyTo], subject: "Re: Invoice 1042",
      text: "Paid it this morning, thanks.\n\nOn Mon, 5 Oct 2026, Replies Co <office@replies-co.example> wrote:\n> Your invoice is attached.",
    });
    expect(outcome).toMatchObject({ kind: "recorded", outcome: { kind: "message", conversationId: invoiceThread, matchedBy: "token" } });
    const [message] = await raw<{ body: string; direction: string; channel: string; read_at: Date | null }[]>`
      select body, direction, channel, read_at from public.message where provider_message_id = 'in_1'`;
    expect(message).toEqual({ body: "Paid it this morning, thanks.", direction: "inbound", channel: "email", read_at: null });
    const [event] = await raw<{ payload: { channel: string } }[]>`
      select payload from public.domain_event where organization_id = ${ORG} and name = 'message.received'`;
    expect(event!.payload.channel).toBe("email");
  });

  it("stores a retried delivery once", async () => {
    const again = await post({ email_id: "in_1", from: CUSTOMER, to: [replyTo], subject: "Re: Invoice 1042", text: "Paid it this morning, thanks." });
    expect(again).toMatchObject({ outcome: { kind: "duplicate" } });
    const stored = await raw`select 1 from public.message where provider_message_id = 'in_1'`;
    expect(stored).toHaveLength(1);
  });

  it("puts a reply from the customer's other address in the same thread, because the token decides", async () => {
    const outcome = await post({ email_id: "in_2", from: "jo@work.example", to: [replyTo], subject: "Re: Invoice 1042", text: "From work: receipt please." });
    expect(outcome).toMatchObject({ outcome: { kind: "message", conversationId: invoiceThread } });
  });

  it("keeps an out of office in the thread without announcing it or counting it unread", async () => {
    const before = await raw`select 1 from public.domain_event where organization_id = ${ORG} and name = 'message.received'`;
    const outcome = await post({
      email_id: "in_auto", from: CUSTOMER, to: [replyTo], subject: "Out of office", text: "I am away until Monday.",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    expect(outcome).toMatchObject({ outcome: { kind: "message", automatic: true } });
    const after = await raw`select 1 from public.domain_event where organization_id = ${ORG} and name = 'message.received'`;
    expect(after.length).toBe(before.length);
    const [message] = await raw<{ read_at: Date | null }[]>`select read_at from public.message where provider_message_id = 'in_auto'`;
    expect(message!.read_at).not.toBeNull();
  });

  it("starts a thread of its own for somebody writing to the reply address fresh", async () => {
    const outcome = await post({ email_id: "in_3", from: "new@lead.example", to: [`reply+nothing-real-here-at-all@${DOMAIN}`], subject: "Quote?", text: "Do you fit heat pumps?" });
    expect(outcome).toMatchObject({ outcome: { kind: "message", matchedBy: "address" } });
    if (outcome.kind !== "recorded" || outcome.outcome.kind !== "message") throw new Error("not stored");
    expect(outcome.outcome.conversationId).not.toBe(invoiceThread);
  });

  it("ignores the company's own address coming back to it", async () => {
    expect(await post({ email_id: "in_loop", from: FROM, to: [replyTo], subject: "Loop", text: "x" }))
      .toMatchObject({ outcome: { kind: "ignored", reason: "own_address" } });
  });

  it("asks to be sent again later when the words could not be fetched", async () => {
    expect(await post({ email_id: "in_envelope", from: CUSTOMER, to: [replyTo], subject: "Re: Invoice 1042" }))
      .toEqual({ kind: "rejected", reason: "body_unavailable" });
  });

  it("still records a delivery receipt on the same endpoint", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_unknown" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const outcome = await emailInbound.receiveByToken(db(), {
      token: TOKEN, url: "https://ots.test/x",
      headers: { "svix-id": "d1", "svix-timestamp": timestamp, "svix-signature": `v1,${svixSignature(SECRET, "d1", timestamp, body)}` },
      rawBody: body,
    }, readSecret);
    expect(outcome).toMatchObject({ kind: "recorded", outcome: { recorded: false, reason: "unknown_message" } });
  });
});

run("answering it from the inbox", () => {
  it("shows the thread as an email thread that can be answered", async () => {
    const thread = await comms.handlers.getConversation(owner(), { id: invoiceThread });
    expect(thread.canReply).toBe(true);
    expect(thread.messages.find((m) => m.direction === "inbound")).toMatchObject({ subject: "Re: Invoice 1042", fromAddress: CUSTOMER });
  });

  it("answers by email, under the thread's subject and reply address, not by text", async () => {
    const sent = await comms.reply(owner(), { id: invoiceThread, body: "Receipt attached. Thanks!" }) as Record<string, unknown>;
    const [message] = await raw<{ channel: string; subject: string; to_address: string; headers: Record<string, string> }[]>`
      select channel, subject, to_address, headers from public.message where id = ${String(sent["id"])}`;
    expect(message).toMatchObject({ channel: "email", subject: "Re: Invoice 1042", to_address: CUSTOMER });
    expect(message!.headers["Reply-To"]).toBe(replyTo);
  });
});
