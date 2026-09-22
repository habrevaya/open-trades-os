import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createClient } from "@opentradesos/db";
import { PermissionError } from "@opentradesos/core";
import { packById, packs } from "@opentradesos/trade-packs";
import { applyTradePack } from "../src/services/trade-pack";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg } from "./helpers";

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const ORG = "eeee1111-1111-1111-1111-111111111111";
const USER = "ffff1111-1111-1111-1111-111111111111";
let raw: postgres.Sql;

const ctx = (roles: ServiceContext["actor"]["roles"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles },
  db: createClient(url!),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pack Test", slug: "pack-test" });
});

afterAll(async () => { if (raw) await raw.end(); });

run("applying a trade pack", () => {
  it("refuses without settings:write", async () => {
    await expect(applyTradePack(ctx(["technician"]), "hvac")).rejects.toThrow(PermissionError);
  });

  it("refuses a pack that does not exist", async () => {
    await expect(applyTradePack(ctx(["owner"]), "not-a-trade")).rejects.toThrow(NotFoundError);
  });

  it("seeds the price book, job types and categories", async () => {
    const pack = packById("hvac")!;
    const result = await applyTradePack(ctx(["owner"]), "hvac");

    expect(result.created.priceBookItems).toBe(pack.priceBook.length);
    expect(result.created.jobTypes).toBe(pack.jobTypes.length);
    expect(result.skipped.priceBookItems).toBe(0);

    const items = await raw`select count(*)::int as n from public.price_book_item where organization_id = ${ORG}`;
    expect(items[0]!.n).toBe(pack.priceBook.length);
  });

  it("creates version 1 of every item, which is what documents reference", async () => {
    const versions = await raw`
      select count(*)::int as n from public.price_book_item_version
      where organization_id = ${ORG} and version = 1`;
    expect(versions[0]!.n).toBe(packById("hvac")!.priceBook.length);
  });

  it("carries price and cost through as exact decimals", async () => {
    const [row] = await raw`
      select v.price, v.cost from public.price_book_item i
      join public.price_book_item_version v on v.item_id = i.id
      where i.organization_id = ${ORG} and i.code = 'MAINT-TUNE'`;
    // numeric(14,4), so what went in is what comes out. No float drift.
    expect(row!.price).toBe("189.0000");
    expect(row!.cost).toBe("62.0000");
  });

  it("sets the organization's trade", async () => {
    const [org] = await raw`select primary_trade from public.organization where id = ${ORG}`;
    expect(org!.primary_trade).toBe("hvac");
  });

  it("seeds the readings as a service report template", async () => {
    const [tpl] = await raw`select fields from public.service_report_template where organization_id = ${ORG}`;
    expect(Array.isArray(tpl!.fields)).toBe(true);
    expect((tpl!.fields as unknown[]).length).toBe(packById("hvac")!.readings.length);
  });

  it("seeds the portal layout in order", async () => {
    const blocks = await raw`
      select b.kind from public.portal_block b
      join public.portal_layout l on l.id = b.layout_id
      where b.organization_id = ${ORG} order by b.sort_order`;
    expect(blocks.map((b) => b.kind)).toEqual(packById("hvac")!.portalBlocks.map((b) => b.kind));
  });

  /**
   * The rule that matters most for a pack UPDATE. A company that edited a
   * price has told us something, and re-applying must not silently undo it.
   */
  it("never overwrites, and reports what it skipped", async () => {
    await raw`
      update public.price_book_item_version set price = '249.0000'
      where organization_id = ${ORG} and item_id = (
        select id from public.price_book_item where organization_id = ${ORG} and code = 'MAINT-TUNE')`;

    const again = await applyTradePack(ctx(["owner"]), "hvac");
    expect(again.created.priceBookItems).toBe(0);
    expect(again.skipped.priceBookItems).toBe(packById("hvac")!.priceBook.length);

    const [row] = await raw`
      select v.price from public.price_book_item i
      join public.price_book_item_version v on v.item_id = i.id
      where i.organization_id = ${ORG} and i.code = 'MAINT-TUNE'`;
    expect(row!.price).toBe("249.0000");
  });

  it("tags seeded rows with the pack and version, for a later upgrade path", async () => {
    const [row] = await raw`
      select trade_pack_id from public.price_book_item
      where organization_id = ${ORG} and code = 'MAINT-TUNE'`;
    expect(row!.trade_pack_id).toBe(`hvac@${packById("hvac")!.version}`);
  });

  it("writes an audit entry naming the pack", async () => {
    const rows = await raw`
      select after from public.audit_log
      where organization_id = ${ORG} and action = 'trade_pack.applied' limit 1`;
    expect((rows[0]!.after as { packId: string }).packId).toBe("hvac");
  });
});

run("every shipped pack applies cleanly", () => {
  /**
   * Structural validation proves a pack parses. Only this proves it survives
   * contact with the real schema: enum values that exist, jsonb shapes the
   * columns accept, no code colliding with a constraint.
   */
  // Deterministic and, importantly, valid hex. Deriving a uuid from the pack
  // id directly produced strings like "hvac" in a hex position, which Postgres
  // rejects before the test can tell you anything useful.
  const orgFor = (index: number) =>
    `aaaa0000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;

  it.each(packs.map((p, i) => [p.id, i] as const))("applies %s to a fresh company", async (packId, index) => {
    const org = orgFor(index);
    await resetOrg(raw, org);
    await raw`insert into public.organization (id, name, slug)
      values (${org}, ${packId}, ${`t-${packId}`})`;
    await raw`insert into public.membership (organization_id, user_id, role)
      values (${org}, ${USER}, 'owner')`;

    const result = await applyTradePack(
      { actor: { userId: USER, organizationId: org, roles: ["owner"] }, db: createClient(url!) },
      packId,
    );
    expect(result.created.priceBookItems).toBeGreaterThan(0);
    expect(result.created.jobTypes).toBeGreaterThan(0);
  });
});
