import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { PermissionError, pdf, type Actor, type Permission } from "@opentradesos/core";
import * as priceBook from "../src/services/pricebook";
import * as repricing from "../src/services/repricing";
import * as estimates from "../src/services/estimates";
import * as proposals from "../src/services/proposals";
import * as templates from "../src/services/proposal-templates";
import * as documents from "../src/services/documents";
import { uploadPriceBookPicture } from "../src/contracts/pricebook";
import type { ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * AN ITEM'S PICTURE, AS A FILE IN THE COMPANY'S OWN STORE
 *
 * Uploaded onto the item and written into a new version, so it is carried
 * forward by every revision and an estimate keeps the picture of the version
 * it was priced from. Drawn for the office under the price book's own read,
 * and for a customer only through an estimate with a line priced from that
 * version: never another file, never another estimate's item, and never the
 * web address somebody typed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pb-picture-file:org");
const USER = fixtureId("pb-picture-file:user");
let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const as = (grants: Permission[]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: [], grants }, db: db() });

/** A one pixel JPEG, which is all the PDF needs to embed a picture. */
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0xff, 0xd9,
]);
/** The same picture, one byte different, so it is a different file. */
const OTHER = Uint8Array.from([...JPEG.slice(0, -3), 0x21, 0xff, 0xd9]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let customerId = "";
let propertyId = "";
let n = 0;
const made = async () => (await priceBook.create(owner(), {
  kind: "equipment", code: `PICF-${++n}`, name: `Condenser ${n}`, price: "3800.00", taxable: true,
})).id;
const versions = (itemId: string) => raw<{ version: number; picture_key: string | null; image_url: string | null }[]>`
  select version, picture_key, image_url from public.price_book_item_version where item_id = ${itemId} order by version`;
const tokenOf = (link: string | null) => link!.split("/").pop()!;
const lineFrom = (itemId: string | undefined, name: string) => ({
  ...(itemId ? { priceBookItemId: itemId } : {}),
  name, quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
});
const anEstimate = (lines: ReturnType<typeof lineFrom>[]) => estimates.create(owner(), {
  customerId, propertyId, taxRate: "0", options: [{ name: "Replace it", isRecommended: true, lines }],
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Picture File Heating", slug: "pb-picture-file-co" });
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Robin Picture') returning id`;
  customerId = c!["id"];
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Lens Rd', 'Austin', 'TX', '78702') returning id`;
  propertyId = p!["id"];
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
});
afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("uploading one", () => {
  it("keeps the file, writes a new version with it and attaches it to the item", async () => {
    const id = await made();
    const shown = await priceBook.uploadPicture(owner(), { id, fileName: "condenser.jpg", bytes: base64(JPEG) });
    expect(shown).toMatchObject({ version: 2, hasPicture: true, imageUrl: null });
    const history = await versions(id);
    expect(history.map((v) => v.picture_key === null)).toEqual([true, false]);
    const [attached] = await raw<{ kind: string; storage_key: string; content_type: string }[]>`
      select kind, storage_key, content_type from public.attachment where entity_type = 'price_book_item' and entity_id = ${id}`;
    expect(attached).toMatchObject({ kind: "picture", storage_key: history[1]!.picture_key, content_type: "image/jpeg" });
    const served = await priceBook.pictureOfVersion(owner(), { versionId: shown.versionId });
    expect(served).toMatchObject({ contentType: "image/jpeg" });
    expect(served.bytes.length).toBe(JPEG.length);
    const [audited] = await raw<{ after: Record<string, unknown> }[]>`
      select after from public.audit_log where entity_id = ${id} and action = 'pricebook.item_revised'`;
    expect(audited!.after["pictureKey"]).toBe(history[1]!.picture_key);
  });

  it("writes nothing when the same picture is sent again, or when a key is replayed", async () => {
    const id = await made();
    await priceBook.uploadPicture(owner(), { id, fileName: "a.jpg", bytes: base64(JPEG) });
    await priceBook.uploadPicture(owner(), { id, fileName: "a again.jpg", bytes: JPEG });
    expect(await versions(id)).toHaveLength(2);
    const keyed = { ...owner(), idempotencyKey: `pic-${id}` };
    const first = await priceBook.uploadPicture(keyed, { id, fileName: "b.jpg", bytes: base64(OTHER) });
    const again = await priceBook.uploadPicture({ ...owner(), idempotencyKey: `pic-${id}` }, { id, fileName: "b.jpg", bytes: base64(OTHER) });
    expect(again.versionId).toBe(first.versionId);
    expect(await versions(id)).toHaveLength(3);
  });

  it("refuses what is not a picture a browser draws, and anything over the cap, writing nothing", async () => {
    const id = await made();
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\n%a document\n");
    await expect(priceBook.uploadPicture(owner(), { id, fileName: "spec.pdf", bytes: pdfBytes }))
      .rejects.toThrow("a JPEG, a PNG, a GIF or a WebP");
    await expect(priceBook.uploadPicture(owner(), { id, fileName: "notes.jpg", bytes: new TextEncoder().encode("hello there") }))
      .rejects.toThrow();
    const huge = new Uint8Array(priceBook.PICTURE_LIMIT + 1);
    huge.set(JPEG.slice(0, 20));
    await expect(priceBook.uploadPicture(owner(), { id, fileName: "huge.jpg", bytes: huge })).rejects.toThrow();
    expect(await versions(id)).toHaveLength(1);
    const [attached] = await raw<{ count: number }[]>`
      select count(*)::int as count from public.attachment where entity_type = 'price_book_item' and entity_id = ${id}`;
    expect(attached!.count).toBe(0);
  });

  it("is refused while a revision waits, so its day does not take the picture off", async () => {
    const id = await made();
    await priceBook.revise(owner(), { id, price: "3900.00", effectiveFrom: new Date(Date.now() + 5 * 864e5).toISOString() });
    await expect(priceBook.uploadPicture(owner(), { id, fileName: "c.jpg", bytes: JPEG }))
      .rejects.toThrow("price change waiting");
    expect(await versions(id)).toHaveLength(2);
  });

  it("takes no storage key from a caller: the route has bytes and nothing else", () => {
    const parsed = uploadPriceBookPicture.input.safeParse({ id: crypto.randomUUID(), fileName: "x.jpg", bytes: base64(JPEG), storageKey: "elsewhere" });
    expect(parsed.success && "storageKey" in parsed.data).toBe(false);
  });
});

run("carried forward and taken off", () => {
  it("survives a price change, a typed address and a bulk change, and comes off as a new version", async () => {
    const id = await made();
    await priceBook.uploadPicture(owner(), { id, fileName: "d.jpg", bytes: JPEG });
    await priceBook.revise(owner(), { id, price: "3950.00" });
    await priceBook.revise(owner(), { id, imageUrl: "https://images.example.com/d.jpg" });
    await repricing.apply(owner(), { selection: { itemIds: [id] }, rule: { adjust: { kind: "percent", percent: "5" } } });
    const before = await versions(id);
    expect(before).toHaveLength(5);
    expect(new Set(before.slice(1).map((v) => v.picture_key)).size).toBe(1);
    expect(before.at(-1)!.image_url).toBe("https://images.example.com/d.jpg");

    const off = await priceBook.removePicture(owner(), { id });
    expect(off).toMatchObject({ version: 6, hasPicture: false, imageUrl: "https://images.example.com/d.jpg" });
    /** Taking it off again writes nothing. */
    await priceBook.removePicture(owner(), { id });
    expect(await versions(id)).toHaveLength(6);

    /** The version before still shows it, so an estimate priced from it still does. */
    const detail = await priceBook.detail(owner(), { id });
    expect(detail.versions.map((v) => v.hasPicture)).toEqual([false, true, true, true, true, false]);
    const earlier = detail.versions.find((v) => v.version === 5)!;
    expect((await priceBook.pictureOfVersion(owner(), { versionId: earlier.id })).contentType).toBe("image/jpeg");
    await expect(priceBook.pictureOfVersion(owner(), { versionId: off.versionId })).rejects.toThrow("not found");
  });
});

run("who may", () => {
  it("uploads and takes off with the price book's write; reads with its read; nothing without it", async () => {
    const id = await made();
    await expect(priceBook.uploadPicture(as(["pricebook:read"]), { id, fileName: "e.jpg", bytes: JPEG })).rejects.toThrow(PermissionError);
    const shown = await priceBook.uploadPicture(as(["pricebook:read", "pricebook:write"]), { id, fileName: "e.jpg", bytes: JPEG });
    await expect(priceBook.removePicture(as(["pricebook:read"]), { id })).rejects.toThrow(PermissionError);
    expect((await priceBook.pictureOfVersion(as(["pricebook:read"]), { versionId: shown.versionId })).contentType).toBe("image/jpeg");
    /** Reading documents is not reading the price book. */
    await expect(priceBook.pictureOfVersion(as(["document:read"]), { versionId: shown.versionId })).rejects.toThrow(PermissionError);
  });
});

run("on an estimate", () => {
  it("is drawn on each line priced from a version that carries it, for the office and on the customer's link", async () => {
    const pictured = await made();
    const typedOnly = await made();
    const shown = await priceBook.uploadPicture(owner(), { id: pictured, fileName: "f.jpg", bytes: JPEG });
    await priceBook.revise(owner(), { id: typedOnly, imageUrl: "https://images.example.com/never-drawn.jpg" });
    const written = await anEstimate([
      lineFrom(pictured, "Condenser"), lineFrom(typedOnly, "Coil"), lineFrom(undefined, "Haul away the old one"),
    ]);

    const doc = await proposals.proposal(owner(), { id: written.id });
    const lines = doc.options[0]!.lines;
    /** A line from the book takes the item's name; the typed one keeps its own. */
    expect(lines.map((l) => l.picture)).toEqual([`item-${shown.versionId}`, null, null]);
    expect(lines[2]!.name).toBe("Haul away the old one");
    expect(JSON.stringify(doc)).not.toContain("never-drawn");
    expect(JSON.stringify(doc)).not.toContain("picture_key");

    const office = await templates.proposalPhoto(owner(), { estimateId: written.id, photoId: `item-${shown.versionId}` });
    expect(office.bytes.length).toBe(JPEG.length);

    const sent = await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 30 });
    const token = tokenOf(sent.approvalUrl);
    expect((await proposals.proposalForToken(db(), token)).options[0]!.lines[0]!.picture).toBe(`item-${shown.versionId}`);
    const theirs = await proposals.proposalPhotoForToken(db(), token, `item-${shown.versionId}`);
    expect(theirs).toMatchObject({ contentType: "image/jpeg" });
  });

  it("keeps the picture of the version it was priced from when the item's picture changes", async () => {
    const id = await made();
    const first = await priceBook.uploadPicture(owner(), { id, fileName: "g.jpg", bytes: JPEG });
    const written = await anEstimate([lineFrom(id, "Condenser")]);
    await priceBook.uploadPicture(owner(), { id, fileName: "g2.jpg", bytes: OTHER });
    await priceBook.removePicture(owner(), { id });
    const doc = await proposals.proposal(owner(), { id: written.id });
    expect(doc.options[0]!.lines[0]!.picture).toBe(`item-${first.versionId}`);
    const served = await templates.proposalPhoto(owner(), { estimateId: written.id, photoId: `item-${first.versionId}` });
    expect(Buffer.from(served.bytes).equals(Buffer.from(JPEG))).toBe(true);
  });

  it("serves only the pictures of items on that estimate, and nothing else in the store", async () => {
    const mineItem = await made();
    const theirItem = await made();
    await priceBook.uploadPicture(owner(), { id: mineItem, fileName: "h.jpg", bytes: JPEG });
    const theirs = await priceBook.uploadPicture(owner(), { id: theirItem, fileName: "i.jpg", bytes: OTHER });
    const mine = await anEstimate([lineFrom(mineItem, "Mine")]);
    await anEstimate([lineFrom(theirItem, "Theirs")]);
    const sent = await estimates.send(owner(), { id: mine.id, channel: "link", expiresInDays: 30 });
    const token = tokenOf(sent.approvalUrl);

    /** Another estimate's item, by its version, is not found on this link or for the office. */
    await expect(proposals.proposalPhotoForToken(db(), token, `item-${theirs.versionId}`)).rejects.toThrow("not found");
    await expect(templates.proposalPhoto(owner(), { estimateId: mine.id, photoId: `item-${theirs.versionId}` })).rejects.toThrow("not found");
    /** Nor is a version id with no picture, a made up one or something that is not an id. */
    const [plain] = await raw<{ id: string }[]>`
      select id from public.price_book_item_version where item_id = ${mineItem} and picture_key is null`;
    await expect(proposals.proposalPhotoForToken(db(), token, `item-${plain!.id}`)).rejects.toThrow("not found");
    await expect(proposals.proposalPhotoForToken(db(), token, `item-${crypto.randomUUID()}`)).rejects.toThrow("not found");
    expect(templates.isProposalPhotoId("item-../../files/x")).toBe(false);
    expect(templates.isProposalPhotoId(`item-${crypto.randomUUID()}`)).toBe(true);
  });

  it("prints the picture in the proposal PDF, once per option, named by its line", async () => {
    const id = await made();
    await priceBook.uploadPicture(owner(), { id, fileName: "j.jpg", bytes: JPEG });
    const written = await anEstimate([lineFrom(id, "Condenser"), lineFrom(id, "Condenser")]);
    const name = (await priceBook.detail(owner(), { id })).name;
    const file = await documents.proposalPdf(owner(), { id: written.id });
    const read = pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));
    expect(read.problems).toEqual([]);
    expect(new TextDecoder("latin1").decode(file.bytes).match(/\/Subtype \/Image/g)).toHaveLength(1);
    /** The caption under the picture, then the item's two lines in the table. */
    expect(read.pages.flat().filter((text) => text === name)).toHaveLength(3);

    const sent = await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 30 });
    const theirs = await documents.proposalPdfForToken(db(), { token: tokenOf(sent.approvalUrl) });
    expect(new TextDecoder("latin1").decode(theirs.bytes).match(/\/Subtype \/Image/g)).toHaveLength(1);
  });
});
