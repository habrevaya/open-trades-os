import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor, type Permission } from "@opentradesos/core";
import * as priceBook from "../src/services/pricebook";
import * as repricing from "../src/services/repricing";
import { revisePriceBookItem } from "../src/contracts/pricebook";
import type { ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * AN ITEM'S PICTURE AND COMMISSION RATE, CHANGED THROUGH A REVISION
 *
 * Both live on the version, so changing either writes a new one and leaves every
 * estimate and invoice with the version it used. Left off a revision, each carries
 * forward (a price rise must not drop them, whoever makes it, however it is made);
 * null takes it off. A commission rate is a pay term, so naming one needs the
 * commission permission as well as the price book's, and it is not shown to anybody
 * who may not read commission.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pb-picture-commission:org");
const USER = fixtureId("pb-picture-commission:user");
let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const as = (grants: Permission[]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: [], grants }, db: db() });
/** Writes the price book and sees commission, but may not set it. */
const editor = () => as(["pricebook:read", "pricebook:write", "commission:read"]);
/** Writes the price book and cannot see commission at all. */
const blind = () => as(["pricebook:read", "pricebook:write"]);

let n = 0;
const made = async () => (await priceBook.create(owner(), {
  kind: "material", code: `PIC-${++n}`, name: "Capacitor", price: "40.00", taxable: true,
})).id;
const versions = (itemId: string) => raw<{ version: number; image_url: string | null; commission_rate: string | null }[]>`
  select version, image_url, commission_rate from public.price_book_item_version where item_id = ${itemId} order by version`;
const PICTURE = "https://images.example.com/capacitor.jpg";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Picture Co", slug: "pb-picture-commission-co" });
});
afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("changing them", () => {
  it("writes a new version with both, and leaves the old one saying what it said", async () => {
    const id = await made();
    const revised = await priceBook.revise(owner(), { id, imageUrl: PICTURE, commissionRate: "0.085" });
    expect(revised).toMatchObject({ version: 2, imageUrl: PICTURE, commissionRate: "0.085000" });
    expect(await versions(id)).toEqual([
      { version: 1, image_url: null, commission_rate: null },
      { version: 2, image_url: PICTURE, commission_rate: "0.085000" },
    ]);
  });

  it("carries both forward through a price change, a kit change and a bulk change", async () => {
    const id = await made();
    await priceBook.revise(owner(), { id, imageUrl: PICTURE, commissionRate: "0.1" });
    await priceBook.revise(editor(), { id, price: "45.00" });
    await priceBook.revise(owner(), { id, components: [] });
    await repricing.apply(owner(), { selection: { itemIds: [id] }, rule: { adjust: { kind: "percent", percent: "10" } } });
    const history = await versions(id);
    expect(history.map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
    expect(history.slice(1).map((v) => [v.image_url, v.commission_rate])).toEqual(Array(4).fill([PICTURE, "0.100000"]));
  });

  it("takes either off with null, and the other stays", async () => {
    const id = await made();
    await priceBook.revise(owner(), { id, imageUrl: PICTURE, commissionRate: "0.05" });
    await priceBook.revise(owner(), { id, imageUrl: null });
    await priceBook.revise(owner(), { id, commissionRate: null });
    const history = await versions(id);
    expect(history.map((v) => [v.image_url, v.commission_rate])).toEqual([
      [null, null], [PICTURE, "0.050000"], [null, "0.050000"], [null, null],
    ]);
  });

  it("can be dated ahead like any other revision, and waits beside the one in force", async () => {
    const id = await made();
    await priceBook.revise(owner(), { id, commissionRate: "0.2", effectiveFrom: new Date(Date.now() + 5 * 864e5).toISOString() });
    const shown = await priceBook.detail(owner(), { id });
    expect(shown.versions.map((v) => v.state)).toEqual(["scheduled", "in_force"]);
    expect(shown).toMatchObject({ commissionRate: null });
  });

  it("is in the audit log, before and after", async () => {
    const id = await made();
    await priceBook.revise(owner(), { id, imageUrl: PICTURE, commissionRate: "0.07" });
    const [row] = await raw<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select before, after from public.audit_log where entity_id = ${id} and action = 'pricebook.item_revised'`;
    expect(row!.before).toMatchObject({ imageUrl: null, commissionRate: null });
    expect(row!.after).toMatchObject({ imageUrl: PICTURE, commissionRate: "0.070000" });
  });
});

run("who may set a commission rate", () => {
  it("needs the commission permission as well as the price book's, and refuses without changing anything", async () => {
    const id = await made();
    await expect(priceBook.revise(editor(), { id, commissionRate: "0.1" })).rejects.toThrow(PermissionError);
    await expect(priceBook.revise(editor(), { id, commissionRate: null })).rejects.toThrow(PermissionError);
    expect(await versions(id)).toHaveLength(1);
    // The picture and the price are the price book's own.
    await priceBook.revise(editor(), { id, imageUrl: PICTURE, price: "41.00" });
    expect(await versions(id)).toHaveLength(2);
  });

  it("is shown only to somebody who may read commission", async () => {
    const id = await made();
    await priceBook.revise(owner(), { id, commissionRate: "0.1" });
    expect((await priceBook.detail(editor(), { id })).commissionRate).toBe("0.100000");
    expect("commissionRate" in (await priceBook.detail(blind(), { id }))).toBe(false);
    // A revision by somebody who cannot see it does not drop it.
    await priceBook.revise(blind(), { id, price: "42.00" });
    expect((await versions(id)).at(-1)!.commission_rate).toBe("0.100000");
  });
});

describe("what the route takes", () => {
  const parse = (body: Record<string, unknown>) => revisePriceBookItem.input.safeParse({ id: crypto.randomUUID(), ...body });

  it("takes an https picture, or null, and nothing else", () => {
    expect(parse({ imageUrl: PICTURE }).success).toBe(true);
    expect(parse({ imageUrl: null }).success).toBe(true);
    for (const bad of ["http://example.com/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd",
      "//example.com/a.jpg", "https://example.com/a b.jpg", `https://example.com/${"a".repeat(2000)}`, ""]) {
      expect(parse({ imageUrl: bad }).success, bad).toBe(false);
    }
  });

  it("takes a share from 0 to 1, or null, and nothing else", () => {
    for (const ok of ["0", "0.08", "0.085", "1", "1.0", "0.123456", null]) expect(parse({ commissionRate: ok }).success, String(ok)).toBe(true);
    for (const bad of ["8", "-0.1", "1.01", "2", "0.1234567", "abc", "", "8%"]) expect(parse({ commissionRate: bad }).success, bad).toBe(false);
  });
});
