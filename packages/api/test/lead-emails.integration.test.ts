import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import * as leadEmails from "../src/services/lead-emails";
import * as emailInbound from "../src/services/email-inbound";
import * as marketplaceLeads from "../src/services/marketplace-leads";
import { svixSignature } from "../src/email/resend";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, escapeRegExp } from "./helpers";

/**
 * THE LEAD INBOX, THROUGH THE SIGNED EMAIL WEBHOOK
 *
 * A marketplace's lead email forwarded to the company's lead inbox arrives on
 * the same signed endpoint a customer's reply does, and becomes a lead offer
 * credited to the platform that sent it. An email delivered twice is one
 * lead; the same lead by email and by the platform's API is one lead; the
 * customer writing again is a line in the lead's thread; and an email that
 * cannot be read (no way to reach anybody, or not a marketplace's at all) is
 * kept with the reason and its words, never dropped. A forged post opens
 * nothing.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("lead-emails:org");
const USER = fixtureId("lead-emails:user");
const DOMAIN = "replies.inbox-co.example";
const TOKEN = "f".repeat(20) + randomBytes(12).toString("hex");
const SECRET = `whsec_${Buffer.from("resend-signing-key-for-lead-inbox").toString("base64")}`;
const secrets: Record<string, string> = { RESEND_HOOK: SECRET, RESEND_KEY: "re_test_key" };
const readSecret = async (ref: string) => {
  const value = secrets[ref];
  if (!value) throw new Error(`no secret ${ref}`);
  return value;
};

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db() });

let inbox = "";
let sequence = 0;
function deliver(data: Record<string, unknown>, options: { forge?: boolean } = {}) {
  const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data });
  sequence += 1;
  const id = `msg_lead_${sequence}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = svixSignature(SECRET, id, timestamp, options.forge ? `${body} ` : body);
  return emailInbound.receiveByToken(db(), {
    token: TOKEN,
    url: `https://ots.test/api/webhooks/email/${TOKEN}`,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    rawBody: body,
  }, readSecret);
}

const ANGI_EMAIL = [
  "You have a new lead!",
  "",
  "Customer Name: Priya Shah",
  "Phone: (512) 555-0163",
  "Email: priya@example.com",
  "Address: 77 Bluebonnet Ln, Austin, TX 78745",
  "Task: Repair a Water Heater",
  "Comments: Pilot light keeps going out.",
  "",
  "View the lead: https://pro.angi.com/leads/5550123?leadOid=5550123",
  "Questions? Call our support line at (877) 555-0100",
].join("\n");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Inbox Co", slug: "lead-emails-co" });
});
afterAll(async () => { if (raw) await raw.end(); });

run("the lead inbox address", () => {
  it("says what is missing until the company can receive email, then is one address that stays put", async () => {
    const before = await leadEmails.inbox(ctx());
    expect(before.address).toBeNull();
    expect(before.missing).toContain("Connect an email provider");
    expect(before.platforms.find((p) => p.key === "nextdoor")).toMatchObject({ api: "none", needsApproval: false });

    await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
              values (${ORG}, 'email', 'resend', 'connected', 'RESEND_KEY',
                      ${raw.json({ fromAddress: "office@inbox-co.example", replyDomain: DOMAIN, webhookToken: TOKEN, webhookSecretRef: "RESEND_HOOK", baseUrl: "http://127.0.0.1:9" })})`;
    inbox = (await leadEmails.inbox(ctx())).address!;
    expect(inbox).toMatch(new RegExp(`^leads\\+[a-z0-9_-]{16,}@${escapeRegExp(DOMAIN)}$`));
    expect((await leadEmails.inbox(ctx())).address).toBe(inbox);
  });
});

run("a marketplace's lead email", () => {
  let angiOffer = "";

  it("refuses a post the provider did not sign", async () => {
    const outcome = await deliver({ email_id: "le_forged", from: "Angi Leads <leads@angi.com>", to: [inbox], subject: "New lead", text: ANGI_EMAIL }, { forge: true });
    expect(outcome).toEqual({ kind: "rejected", reason: "bad_signature" });
  });

  it("becomes a lead offer credited to the platform, from a forwarding rule that kept the original To line", async () => {
    const outcome = await deliver({
      email_id: "le_1", from: "Angi Leads <leads@angi.com>", to: ["owner@inbox-co.example"], subject: "New lead: Priya Shah",
      text: ANGI_EMAIL, headers: [{ name: "Delivered-To", value: inbox }],
    });
    expect(outcome).toMatchObject({ kind: "recorded", outcome: { kind: "lead_email", outcome: { kind: "lead", platform: "angi" } } });
    angiOffer = (outcome as { outcome: { outcome: { offerId: string } } }).outcome.outcome.offerId;
    const detail = await marketplaceLeads.offerDetail(ctx(), { id: angiOffer });
    expect(detail).toMatchObject({
      externalId: "5550123", contactName: "Priya Shah", contactPhone: "+15125550163", contactEmail: "priya@example.com",
      addressLine1: "77 Bluebonnet Ln", city: "Austin", state: "TX", postalCode: "78745",
      serviceRequested: "Repair a Water Heater", notes: "Pilot light keeps going out.",
      kind: "email", source: "angi", canReply: false,
    });
    const [touch] = await raw<{ source: string }[]>`select source from public.marketing_touch where visitor_id = ${`lead_offer:${angiOffer}`}`;
    expect(touch!.source).toBe("marketplace");
    /** Not a customer reply: nothing landed in the shared inbox. */
    const messages = await raw`select 1 from public.message where organization_id = ${ORG}`;
    expect(messages).toHaveLength(0);
  });

  it("is one lead when delivered again, and one lead when forwarded twice by hand", async () => {
    const again = await deliver({ email_id: "le_1", from: "leads@angi.com", to: [inbox], subject: "New lead: Priya Shah", text: ANGI_EMAIL });
    expect(again).toMatchObject({ outcome: { outcome: { kind: "duplicate", offerId: angiOffer } } });
    const forwarded = await deliver({
      email_id: "le_2", from: "Owner <owner@inbox-co.example>", to: [inbox], subject: "Fwd: New lead: Priya Shah",
      text: `---------- Forwarded message ---------\nFrom: Angi Leads <leads@angi.com>\n\n${ANGI_EMAIL}`,
    });
    expect(forwarded).toMatchObject({ outcome: { outcome: { kind: "duplicate", offerId: angiOffer } } });
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.lead_offer where organization_id = ${ORG}`;
    const n = count!.n;
    expect(n).toBe(1);
  });

  it("adds the customer writing again to the lead's thread", async () => {
    const thumbtack = await deliver({
      email_id: "le_3", from: "Thumbtack <no-reply@thumbtack.com>", to: [inbox], subject: "New request from Marco Diaz",
      text: "Marco Diaz needs a Furnace repair\nPhone: 512.555.0188\nZip code: 78704\nDetails: Blowing cold air.\nhttps://www.thumbtack.com/pro/leads/888123456",
    });
    const offerId = (thumbtack as { outcome: { outcome: { offerId: string } } }).outcome.outcome.offerId;
    expect(thumbtack).toMatchObject({ outcome: { outcome: { kind: "lead", platform: "thumbtack" } } });
    const reply = await deliver({
      email_id: "le_4", from: "Thumbtack <no-reply@thumbtack.com>", to: [inbox], subject: "Marco Diaz sent you a message",
      text: "Customer: Marco Diaz\nMessage: Can you come before noon?",
    });
    expect(reply).toMatchObject({ outcome: { outcome: { kind: "message", offerId } } });
    const detail = await marketplaceLeads.offerDetail(ctx(), { id: offerId });
    expect(detail.messages.map((m) => m.body)).toEqual(["Can you come before noon?"]);
    expect(detail).toMatchObject({ externalId: "888123456", postalCode: "78704", serviceRequested: null });
  });

  it("keeps what it cannot read, with the reason and the words", async () => {
    const nextdoor = await deliver({
      email_id: "le_5", from: "Nextdoor <reply@hello.nextdoor.com>", to: [inbox], subject: "Sam Lee sent your business a message",
      text: "Name: Sam Lee\nMessage: Do you service Travis Heights?",
    });
    expect(nextdoor).toMatchObject({ outcome: { outcome: { kind: "unreadable" } } });
    const gmail = await deliver({
      email_id: "le_6", from: "Gmail Team <forwarding-noreply@google.com>", to: [inbox],
      subject: "(#123456789) Gmail Forwarding Confirmation", text: "Confirmation code: 123456789",
    });
    expect(gmail).toMatchObject({ outcome: { outcome: { kind: "unreadable" } } });

    const unread = await leadEmails.list(ctx(), { outcome: "unreadable" });
    expect(unread.map((e) => e.platform)).toEqual([null, "nextdoor"]);
    expect(unread[0]!.excerpt).toContain("Confirmation code: 123456789");
    expect(unread[1]!.reason).toContain("no phone number or email");
    /** The same email delivered twice is one row; the hand forwarded copy is its own email, and a duplicate lead. */
    const all = await leadEmails.list(ctx());
    expect(all.map((e) => e.outcome).sort()).toEqual(["duplicate", "lead", "lead", "message", "unreadable", "unreadable"]);
  });

  it("stops taking the old address when it is rotated", async () => {
    const rotated = await leadEmails.rotateInbox({ ...ctx(), idempotencyKey: "rotate-inbox-1" });
    expect(rotated.address).not.toBe(inbox);
    const old = await deliver({ email_id: "le_7", from: "leads@angi.com", to: [inbox], subject: "New lead", text: ANGI_EMAIL.replace("5550123", "5550999") });
    /** Not the inbox any more, so it is an ordinary email to the company, not a lead. */
    expect(old).toMatchObject({ kind: "recorded", outcome: { kind: "message" } });
  });
});
