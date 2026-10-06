import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import { packById, type TradePack } from "@opentradesos/trade-packs";
import { applyTradePack, previewUpgradeTo, upgradeTo } from "../src/services/trade-pack";
import * as layout from "../src/services/portal-layout";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE OFFICE ARRANGING A CUSTOMER'S ACCOUNT PAGE
 *
 * From the layout the trade pack seeded: moved, hidden and retitled, and
 * drawn that way on the customer's page. The bills cannot be hidden. And the
 * promise M02 makes about everything a pack sets up: an upgrade never writes
 * over what the company changed, so an arranged layout is kept and listed as
 * the company's, while a company that changed nothing takes the new version.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-layout:org");
const OWNER = fixtureId("portal-layout:owner");
const PLAIN_ORG = fixtureId("portal-layout:plain-org");
const PLAIN_OWNER = fixtureId("portal-layout:plain-owner");
const BARE_ORG = fixtureId("portal-layout:bare-org");
const BARE_OWNER = fixtureId("portal-layout:bare-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (org = ORG, user = OWNER, roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles }, db: db(),
});

const v1 = packById("hvac")!;
const v2: TradePack = {
  ...v1, version: v1.version + 1,
  portalBlocks: [...v1.portalBlocks, { kind: "referral", title: "Tell a neighbour", config: {} }],
} as TradePack;

/** The arrangement as the screen posts it: every block, in order. */
const posted = (rows: layout.LayoutView["blocks"]) => rows.map((r) => ({ kind: r.kind, title: r.title, visible: r.visible }));

/** What the customer's account page draws, through an account link. */
async function drawn(org: string, user: string) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name)
    values (${org}, 'residential', 'Layout Customer') returning id`;
  const link = await inTenant(as(org, user), (tx) => portal.mintGrant(tx, {
    organizationId: org, customerId: c!.id, scope: "customer", expiresInDays: 1,
  }));
  const account = await portalAccount.viewAccount(db(), { token: link.token });
  return account.extras.blocks;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Layout Air", slug: "portal-layout-air" });
  await seedOrg(raw, { organizationId: PLAIN_ORG, userId: PLAIN_OWNER, name: "Plain Air", slug: "portal-layout-plain" });
  await seedOrg(raw, { organizationId: BARE_ORG, userId: BARE_OWNER, name: "Bare Air", slug: "portal-layout-bare" });
  await applyTradePack(as(), "hvac");
  await applyTradePack(as(PLAIN_ORG, PLAIN_OWNER), "hvac");
});

afterAll(async () => {
  if (!raw) return;
  for (const org of [ORG, PLAIN_ORG, BARE_ORG]) await resetOrg(raw, org);
  await raw.end();
});

run("arranging the account page", () => {
  it("starts from the layout the pack seeded, as the customer sees it", async () => {
    const seen = await layout.get(as());
    expect(seen.startedFrom).toBe(`${v1.name} portal`);
    expect(seen.changed).toBe(false);
    const shown = seen.blocks.filter((b) => b.visible).map((b) => b.kind);
    expect(shown.slice(0, v1.portalBlocks.length)).toEqual(v1.portalBlocks.map((b) => b.kind));
    expect(seen.blocks).toHaveLength(14);
    expect((await drawn(ORG, OWNER)).map((b) => b.kind)).toEqual(shown);
  });

  it("moves, hides and retitles, and the customer's page draws it that way", async () => {
    const seen = await layout.get(as());
    const rows = posted(seen.blocks);
    const invoices = rows.findIndex((r) => r.kind === "invoices");
    const [bills] = rows.splice(invoices, 1);
    rows.unshift({ ...bills!, title: "What you owe us" });
    const hidden = rows.find((r) => r.visible && r.kind !== "invoices")!.kind;
    const saved = await layout.set(as(), {
      blocks: rows.map((r) => (r.kind === hidden ? { ...r, visible: false } : r)),
    });
    expect(saved.changed).toBe(true);
    expect(saved.blocks[0]).toMatchObject({ kind: "invoices", title: "What you owe us", customTitle: "What you owe us" });
    const page = await drawn(ORG, OWNER);
    expect(page[0]).toMatchObject({ kind: "invoices", title: "What you owe us" });
    expect(page.map((b) => b.kind)).not.toContain(hidden);
    const [audit] = await raw<{ actor_user_id: string }[]>`select actor_user_id from public.audit_log
      where organization_id = ${ORG} and action = 'portal.layout_changed'`;
    expect(audit!.actor_user_id).toBe(OWNER);
  });

  it("refuses hiding the bills, and somebody who may not change settings", async () => {
    const seen = await layout.get(as());
    await expect(layout.set(as(), {
      blocks: posted(seen.blocks).map((r) => (r.kind === "invoices" ? { ...r, visible: false } : r)),
    })).rejects.toThrow(ConflictError);
    await expect(layout.set(as(ORG, OWNER, ["technician"]), { blocks: posted(seen.blocks) })).rejects.toThrow(PermissionError);
    await expect(layout.get(as(ORG, OWNER, ["technician"]))).rejects.toThrow(PermissionError);
  });

  it("is kept by a pack upgrade as the company's own, while a company that changed nothing takes the new version", async () => {
    const mine = await layout.get(as());
    const { setup } = await previewUpgradeTo(as(), v2);
    expect(setup.kept.find((k) => k.kind === "portal_layout")).toMatchObject({ reason: "edited" });
    await upgradeTo(as(), v2);
    expect((await layout.get(as())).blocks).toEqual(mine.blocks);

    await upgradeTo(as(PLAIN_ORG, PLAIN_OWNER), v2);
    const plain = await layout.get(as(PLAIN_ORG, PLAIN_OWNER));
    expect(plain.blocks.filter((b) => b.visible).map((b) => b.kind)).toContain("referral");
    expect(plain.blocks.find((b) => b.kind === "referral")!.title).toBe("Tell a neighbour");
  });

  it("gives a company with no pack a layout of its own, which a pack applied later does not push aside", async () => {
    const bare = as(BARE_ORG, BARE_OWNER);
    const seen = await layout.get(bare);
    expect(seen.startedFrom).toBeNull();
    const rows = posted(seen.blocks).reverse().map((r) => (r.kind === "invoices" ? r : { ...r, visible: true }));
    await layout.set(bare, { blocks: rows });
    await applyTradePack(bare, "hvac");
    const after = await layout.get(bare);
    expect(after.blocks.map((b) => b.kind)).toEqual(rows.map((r) => r.kind));
    // And another company's arrangement is nowhere on this one.
    expect((await layout.get(as())).blocks[0]!.title).toBe("What you owe us");
    expect(after.blocks.find((b) => b.kind === "invoices")!.title).toBe("Invoices");
  });
});
