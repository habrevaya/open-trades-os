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
 * WORD, SPREADSHEET, TEXT AND ZIP FILES THAT COME WITH AN EMAIL REPLY ARE KEPT, AS DOWNLOADS (M18)
 *
 * Besides pictures and PDFs, a reply may bring a Word document, a spreadsheet, a text file or a zip. Each
 * is decided from its bytes, held to a smaller limit than a picture, and kept only when it holds no macro,
 * program or script. A delivery already stored is recognised before any file is fetched. Resend is a local
 * fake reached through the connection's `baseUrl`, as in the sibling test.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("email-reply-docs:org");
const USER = fixtureId("email-reply-docs:user");
const OTHER_ORG = fixtureId("email-reply-docs:other-org");
const OTHER_USER = fixtureId("email-reply-docs:other-user");
const FROM = "office@reply-docs-co.example";
const DOMAIN = "replies.reply-docs-co.example";
const CUSTOMER = "pat@customer.example";
const TOKEN = "a".repeat(20) + randomBytes(12).toString("hex");
const SECRET = `whsec_${Buffer.from("resend-signing-key-for-reply-docs").toString("base64")}`;
const secrets: Record<string, string> = { RESEND_HOOK: SECRET, RESEND_KEY: "re_test_reply_docs" };
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
        if (!file || request.headers.authorization !== "Bearer re_test_reply_docs") { reply(404, { message: "Not found" }); return; }
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
  const id = `msg_doc_${sequence}`;
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Reply Docs Co", slug: "email-reply-docs" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Reply Docs Co", slug: "email-reply-docs-other" });
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

/* ------------------------------------------------- the four kinds of file */

/** A zip with stored entries, built by hand: local headers, the table of contents and the end record. */
function zipOf(entries: Record<string, string>): Buffer {
  const enc = new TextEncoder();
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, data] of Object.entries(entries)) {
    const n = [...enc.encode(name)];
    const d = [...enc.encode(data)];
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...n, ...d];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n]);
    parts.push(local);
    offset += local.length;
  }
  const cd = central.flat();
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cd.length), ...u32(offset), ...u16(0)];
  return Buffer.from([...parts.flat(), ...cd, ...end]);
}
const docx = (words: string) => zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": `<w>${words}</w>` });
const xlsx = (words: string) => zipOf({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": `<w>${words}</w>` });
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

run("a Word document, a spreadsheet, a text file and a zip that come with a reply", () => {
  it("are kept with the type their bytes are, attached to the message, and served to somebody who may read the thread", async () => {
    const quote = docx("quote for the furnace");
    const parts = xlsx("parts list");
    const list = Buffer.from("Part,Qty\nCapacitor,2\n");
    const note = Buffer.from("Call me after five.\n");
    const folder = zipOf({ "photos/1.jpg": "x", "notes.txt": "y" });
    const outcome = await post("doc_kept", { text: "Everything you asked for." }, [
      { id: "d_docx", filename: "Competitor quote.docx", contentType: "application/octet-stream", bytes: quote },
      { id: "d_xlsx", filename: "Parts.xlsx", contentType: SHEET, bytes: parts },
      { id: "d_csv", filename: "parts.csv", contentType: "text/csv", bytes: list },
      { id: "d_txt", filename: "note.txt", contentType: "text/plain", bytes: note },
      { id: "d_zip", filename: "paperwork.zip", contentType: "application/zip", bytes: folder },
      { id: "d_pdf", filename: "Warranty.pdf", contentType: "application/pdf", bytes: pdfBytes("still kept") },
    ]);
    expect(outcome).toMatchObject({ kind: "recorded", outcome: { kind: "message" } });
    const message = await stored("doc_kept");
    expect(message.media.map((m) => [m.name, m.contentType, Boolean(m.storageKey)])).toEqual([
      ["Competitor quote.docx", WORD, true],
      ["Parts.xlsx", SHEET, true],
      ["parts.csv", "text/csv", true],
      ["note.txt", "text/plain", true],
      ["paperwork.zip", "application/zip", true],
      ["Warranty.pdf", "application/pdf", true],
    ]);
    expect(message.media[0]!.storageKey).toMatch(/\.docx$/);
    expect(message.media[4]!.storageKey).toMatch(/\.zip$/);
    const attached = await raw<{ kind: string; content_type: string }[]>`select kind, content_type from public.attachment
      where organization_id = ${ORG} and entity_type = 'message' and entity_id = ${message.id} order by file_name`;
    expect(attached.map((a) => a.kind)).toEqual(new Array(6).fill("email_attachment"));
    const served = await comms.picture(owner(), { conversationId: message.conversation_id, storageKey: message.media[0]!.storageKey! });
    expect(Buffer.from(served.bytes).equals(quote)).toBe(true);
    expect(served.contentType).toBe(WORD);
    await expect(comms.picture(stranger(), { conversationId: message.conversation_id, storageKey: message.media[0]!.storageKey! }))
      .rejects.toThrow(NotFoundError);
  });

  it("are refused when they could run something, and are named with the reason", async () => {
    const macro = zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w/>", "word/vbaProject.bin": "macros" });
    const dropper = zipOf({ "invoice.pdf.exe": "MZ", "readme.txt": "open me" });
    const page = Buffer.from("<html><script>alert(1)</script></html>");
    const before = downloads.length;
    await post("doc_refused", { text: "Open these." }, [
      { id: "r_macro", filename: "Invoice.docx", contentType: WORD, bytes: macro },
      { id: "r_zip", filename: "documents.zip", contentType: "application/zip", bytes: dropper },
      { id: "r_page", filename: "statement.txt", contentType: "text/plain", bytes: page },
      { id: "r_docm", filename: "Invoice.docm", contentType: "application/vnd.ms-word.document.macroEnabled.12", bytes: docx("macro") },
      { id: "r_old", filename: "Old quote.doc", contentType: "application/msword", bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
      { id: "r_binary", filename: "data.txt", contentType: "text/plain", bytes: Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]) },
    ]);
    const message = await stored("doc_refused");
    expect(message.body).toBe("Open these.");
    expect(message.media.every((m) => !m.storageKey)).toBe(true);
    const why = message.media.map((m) => m.refused ?? "");
    expect(why[0]).toContain("macro");
    expect(why[1]).toContain("program or a script");
    expect(why[2]).toContain("web page or a script");
    expect(why[3]).toContain("program");
    expect(why[4]).toContain("macros");
    expect(why[5]).toContain("not a picture");
    /** The ones named as programs or old Office files are never downloaded at all. */
    expect(downloads.slice(before)).toEqual(["r_macro", "r_zip", "r_page", "r_binary"]);
    expect(await keptWithHash(macro)).toHaveLength(0);
    expect(await keptWithHash(dropper)).toHaveLength(0);
  });

  it("are held to a smaller limit than a picture: one that says it is over is not downloaded, and one that is over is refused", async () => {
    const big = Buffer.concat([Buffer.from("Part,Qty\n"), Buffer.alloc(coreFiles.EMAIL_ATTACHMENTS.maxDocumentBytes + 10, 0x61)]);
    const before = downloads.length;
    await post("doc_big", { text: "Big." }, [
      { id: "b_says", filename: "list.xlsx", contentType: SHEET, bytes: xlsx("small really"), declaredSize: coreFiles.EMAIL_ATTACHMENTS.maxDocumentBytes + 1 },
      { id: "b_is", filename: "all-parts.csv", contentType: "text/csv", bytes: big, declaredSize: 1000 },
      { id: "b_picture", filename: "large.png", contentType: "image/png", bytes: Buffer.concat([pngBytes(77), Buffer.alloc(coreFiles.EMAIL_ATTACHMENTS.maxDocumentBytes + 10)]) },
    ]);
    const message = await stored("doc_big");
    expect(downloads.slice(before)).toEqual(["b_is", "b_picture"]);
    expect(message.media[0]!.refused).toContain("list.xlsx");
    expect(message.media[0]!.refused).toContain("5 MB");
    expect(message.media[1]!.refused).toContain("all-parts.csv");
    expect(message.media[1]!.refused).toContain("5 MB");
    /** A picture of the same size is still fine. */
    expect(message.media[2]!.storageKey).toBeTruthy();
  });
});

run("a delivery the provider sends again", () => {
  it("is recognised before any file is downloaded, and keeps the message and its files once", async () => {
    const file = { id: "dup_file", filename: "Quote.docx", contentType: WORD, bytes: docx("duplicate") };
    const first = await post("doc_dup", { text: "Once." }, [file]);
    expect(first).toMatchObject({ kind: "recorded", outcome: { kind: "message" } });
    const downloadsAfterFirst = downloads.length;
    const second = await post("doc_dup", { text: "Once." }, [file]);
    expect(second).toMatchObject({ kind: "recorded", outcome: { kind: "duplicate" } });
    expect(downloads.length).toBe(downloadsAfterFirst);
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.message
      where organization_id = ${ORG} and provider_message_id = 'doc_dup'`;
    expect(count!.n).toBe(1);
    const attached = await raw`select 1 from public.attachment where organization_id = ${ORG} and entity_id = ${(await stored("doc_dup")).id}`;
    expect(attached).toHaveLength(1);
  });

  it("is still stored once when two deliveries arrive together", async () => {
    const file = { id: "race_file", filename: "Race.xlsx", contentType: SHEET, bytes: xlsx("race") };
    const [a, b] = await Promise.all([post("doc_race", { text: "Together." }, [file]), post("doc_race", { text: "Together." }, [file])]);
    const kinds = [a, b].map((r) => (r as { outcome: { kind: string } }).outcome.kind).sort();
    expect(kinds).toEqual(["duplicate", "message"]);
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.message
      where organization_id = ${ORG} and provider_message_id = 'doc_race'`;
    expect(count!.n).toBe(1);
  });
});
