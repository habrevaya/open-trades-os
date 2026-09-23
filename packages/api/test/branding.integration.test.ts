import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as branding from "../src/services/branding";
import { ConflictError, NotFoundError } from "../src/services/context";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY'S OWN LOOK
 *
 * Two properties matter more than any pixel:
 *
 *   THE BYTES DECIDE WHAT A FILE IS. The content type on an upload is a
 *   string the client chose, and this route serves what it stores back from
 *   the application's own origin.
 *
 *   ONE COMPANY CANNOT FETCH ANOTHER'S MARK. The bytes are served without a
 *   staff permission, because a customer opening a proposal has no account,
 *   so tenancy is the only thing between the two.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("br:org");
const USER = fixtureId("br:user");
const OTHER_ORG = fixtureId("br:other-org");
const OTHER_USER = fixtureId("br:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctxFor = (org: string, user: string, roles: string[] = ["owner"]): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => ctxFor(ORG, USER);
const neighbour = () => ctxFor(OTHER_ORG, OTHER_USER);
const tech = () => ctxFor(ORG, USER, ["technician"]);

/** A real PNG header plus filler, which is all `sniff` looks at. */
const png = (extra = 32) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(extra).fill(7)]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Brand Co", slug: "brand-co" });
  await seedOrg(raw, {
    organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Co", slug: "other-co",
  });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.brand_asset where organization_id in (${ORG}, ${OTHER_ORG})`;
  await raw`update public.organization set brand_color = null where id in (${ORG}, ${OTHER_ORG})`;
});

run("the brand colour", () => {
  it("starts unset, so the product keeps its own look", async () => {
    const current = await branding.current(owner());
    expect(current.color).toBeNull();
    expect(current.on).toBeNull();
    expect(current.text).toBeNull();
  });

  it("stores it canonically, whatever shape it was typed in", async () => {
    await branding.setColor(owner(), { color: "  #1D4ED8 " });
    expect((await branding.current(owner())).color).toBe("#1d4ed8");
  });

  it("derives both forms rather than storing them", async () => {
    /**
     * Storing either means a row where the three can disagree, and the one
     * that disagrees is always the one being read. Only the colour is in
     * the database: the column is the single source.
     */
    await branding.setColor(owner(), { color: "#facc15" });
    const current = await branding.current(owner());
    expect(current.color).toBe("#facc15");
    expect(current.on).toBe("#111827");
    expect(current.text).not.toBe("#facc15");

    const [row] = await raw<{ brand_color: string }[]>`
      select brand_color from public.organization where id = ${ORG}`;
    expect(row!.brand_color).toBe("#facc15");
  });

  it("can be cleared, because undoing a choice is a real answer", async () => {
    await branding.setColor(owner(), { color: "#1d4ed8" });
    await branding.setColor(owner(), { color: "" });
    expect((await branding.current(owner())).color).toBeNull();
  });

  it("refuses something that is not a colour", async () => {
    await expect(branding.setColor(owner(), { color: "chartreuse" }))
      .rejects.toThrow(ConflictError);
  });

  it("is not settable by somebody who may not change settings", async () => {
    await expect(branding.setColor(tech(), { color: "#1d4ed8" })).rejects.toThrow();
  });

  it("is readable by somebody who may not change it", async () => {
    /**
     * No permission on the read, on purpose. A technician cannot open the
     * settings screen and is looking at their own company's application all
     * day: gating this would make them the one person in the company who
     * sees it unbranded.
     */
    await branding.setColor(owner(), { color: "#1d4ed8" });
    expect((await branding.current(tech())).color).toBe("#1d4ed8");
  });
});

run("the marks", () => {
  it("decides the type from the bytes, not from the upload", async () => {
    /**
     * There is nowhere in this API to pass a claimed content type, which is
     * the design rather than an omission: a parameter that exists is a
     * parameter somebody eventually trusts.
     */
    const result = await branding.setAsset(owner(), { kind: "logo", bytes: png() });
    expect(result.contentType).toBe("image/png");

    const [row] = await raw<{ content_type: string }[]>`
      select content_type from public.brand_asset
      where organization_id = ${ORG} and kind = 'logo'`;
    expect(row!.content_type).toBe("image/png");
  });

  it("refuses an SVG, which is a document that can carry script", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(branding.setAsset(owner(), { kind: "logo", bytes: svg }))
      .rejects.toThrow(ConflictError);
  });

  it("replaces rather than accumulating", async () => {
    // A second logo is a logo nothing chooses between, and "which one is
    // live" becomes a question about insertion order.
    await branding.setAsset(owner(), { kind: "logo", bytes: png(32) });
    await branding.setAsset(owner(), { kind: "logo", bytes: png(64) });

    const rows = await raw`select id from public.brand_asset
      where organization_id = ${ORG} and kind = 'logo'`;
    expect(rows).toHaveLength(1);
    expect((await branding.assetBytes(owner(), { kind: "logo" })).bytes).toHaveLength(72);
  });

  it("keeps the logo and the favicon apart", async () => {
    await branding.setAsset(owner(), { kind: "logo", bytes: png(32) });
    await branding.setAsset(owner(), { kind: "favicon", bytes: png(8) });

    const current = await branding.current(owner());
    expect(current.hasLogo).toBe(true);
    expect(current.hasFavicon).toBe(true);
    expect((await branding.assetBytes(owner(), { kind: "favicon" })).bytes).toHaveLength(16);
  });

  it("gives back the exact bytes it was given", async () => {
    // A round trip through bytea is where a stray encoding turns an image
    // into something a browser will not render.
    const bytes = png(200);
    await branding.setAsset(owner(), { kind: "logo", bytes });
    const back = await branding.assetBytes(owner(), { kind: "logo" });
    expect(new Uint8Array(back.bytes)).toEqual(bytes);
  });

  it("is missing rather than empty when there is none", async () => {
    await expect(branding.assetBytes(owner(), { kind: "logo" })).rejects.toThrow(NotFoundError);
  });

  it("can be removed", async () => {
    await branding.setAsset(owner(), { kind: "logo", bytes: png() });
    await branding.clearAsset(owner(), { kind: "logo" });
    expect((await branding.current(owner())).hasLogo).toBe(false);
  });
});

run("one company's mark is not another's", () => {
  it("does not serve a neighbour's logo", async () => {
    /**
     * The bytes are served WITHOUT a staff permission, because a customer
     * opening a proposal has no account at all. Tenancy is therefore the
     * only thing standing between two companies' marks, and there is no id
     * in the path to vary: the organization comes from the session.
     *
     * Worth saying what actually earns this. Removing the `kind` filter
     * from the query in this service does not make this test fail, and
     * nothing else in the service does either: row level security is
     * forced on the table and a read outside the tenant matches no rows.
     * This asserts the property holds end to end, not that the service
     * implements it.
     */
    await branding.setAsset(owner(), { kind: "logo", bytes: png() });

    await expect(branding.assetBytes(neighbour(), { kind: "logo" }))
      .rejects.toThrow(NotFoundError);
    expect((await branding.current(neighbour())).hasLogo).toBe(false);
  });

  it("does not show a neighbour's colour", async () => {
    await branding.setColor(owner(), { color: "#1d4ed8" });
    expect((await branding.current(neighbour())).color).toBeNull();
  });

  it("lets two companies hold different marks at once", async () => {
    await branding.setAsset(owner(), { kind: "logo", bytes: png(32) });
    await branding.setAsset(neighbour(), { kind: "logo", bytes: png(64) });

    expect((await branding.assetBytes(owner(), { kind: "logo" })).bytes).toHaveLength(40);
    expect((await branding.assetBytes(neighbour(), { kind: "logo" })).bytes).toHaveLength(72);
  });
});

run("the cache version", () => {
  it("changes when a mark changes", async () => {
    /**
     * The logo is served with a year long cache, which is only safe because
     * the URL carries this. Without it, replacing a logo means seeing the
     * old one for a week, and nobody connects the two.
     */
    await branding.setAsset(owner(), { kind: "logo", bytes: png(32) });
    const before = (await branding.current(owner())).version;

    await raw`update public.brand_asset set updated_at = now() + interval '1 minute'
              where organization_id = ${ORG} and kind = 'logo'`;

    expect((await branding.current(owner())).version).toBeGreaterThan(before);
  });
});
