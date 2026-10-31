import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import { applyTradePack } from "../src/services/trade-pack";
import * as layout from "../src/services/portal-layout";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";
import { routes } from "../src/contracts/index";

/**
 * GOING BACK TO THE TRADE PACK'S ACCOUNT PAGE
 *
 * An office that rearranged the customer's account page can put it back to what
 * its trade pack sets up: the blocks, their order, what is shown and the
 * headings. A page the office made with no pack (or kept aside when a pack was
 * applied later) is replaced, so the pack's is read again; a page already as the
 * pack set it up is left alone; a company with no pack is told there is nothing
 * to go back to; and a plan's own page is not touched.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-layout-reset:org");
const OWNER = fixtureId("portal-layout-reset:owner");
const LATE_ORG = fixtureId("portal-layout-reset:late-org");
const LATE_OWNER = fixtureId("portal-layout-reset:late-owner");
const BARE_ORG = fixtureId("portal-layout-reset:bare-org");
const BARE_OWNER = fixtureId("portal-layout-reset:bare-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (org = ORG, user = OWNER, roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles }, db: db(),
});
const pack = packById("hvac")!;
const posted = (rows: layout.LayoutView["blocks"]) => rows.map((r) => ({ kind: r.kind, title: r.customTitle, visible: r.visible }));

async function drawn(org: string, user: string) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name)
    values (${org}, 'residential', 'Reset Customer') returning id`;
  const link = await inTenant(as(org, user), (tx) => portal.mintGrant(tx, {
    organizationId: org, customerId: c!.id, scope: "customer", expiresInDays: 1,
  }));
  return (await portalAccount.viewAccount(db(), { token: link.token })).extras.blocks;
}

/** Moves the bills to the top under a heading of the company's own and hides the first other block. */
async function rearranged(ctx: ServiceContext) {
  const rows = posted((await layout.get(ctx)).blocks);
  const [bills] = rows.splice(rows.findIndex((r) => r.kind === "invoices"), 1);
  rows.unshift({ ...bills!, title: "What you owe us" });
  const hide = rows.find((r) => r.visible && r.kind !== "invoices")!.kind;
  return layout.set(ctx, { blocks: rows.map((r) => (r.kind === hide ? { ...r, visible: false } : r)) });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Reset Air", slug: "portal-layout-reset-air" });
  await seedOrg(raw, { organizationId: LATE_ORG, userId: LATE_OWNER, name: "Late Air", slug: "portal-layout-reset-late" });
  await seedOrg(raw, { organizationId: BARE_ORG, userId: BARE_OWNER, name: "Bare Reset", slug: "portal-layout-reset-bare" });
  await applyTradePack(as(), "hvac");
});

afterAll(async () => {
  if (!raw) return;
  for (const org of [ORG, LATE_ORG, BARE_ORG]) await resetOrg(raw, org);
  await raw.end();
});

run("going back to the pack's account page", () => {
  it("offers nothing to go back to while the page is as the pack set it up, and changes nothing if asked", async () => {
    const seen = await layout.get(as());
    expect(seen).toMatchObject({ changed: false, goBackTo: null });
    expect(await layout.resetToPack(as())).toMatchObject({ changed: false, goBackTo: null });
    const [audits] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'portal.layout_reset_to_pack'`;
    expect(audits!.n).toBe(0);
  });

  it("puts the blocks, their order, what is shown and the headings back, and the customer's page draws it", async () => {
    const before = await layout.get(as());
    const mine = await rearranged(as());
    expect(mine).toMatchObject({ changed: true, goBackTo: `${pack.name} portal` });
    expect((await drawn(ORG, OWNER))[0]).toMatchObject({ kind: "invoices", title: "What you owe us" });

    const back = await layout.resetToPack(as());
    expect(back).toMatchObject({ changed: false, goBackTo: null, startedFrom: `${pack.name} portal` });
    expect(back.blocks).toEqual(before.blocks);
    expect((await drawn(ORG, OWNER)).map((b) => b.kind)).toEqual(before.blocks.filter((b) => b.visible).map((b) => b.kind));

    const [audit] = await raw<{ actor_user_id: string; before: { blocks: unknown[] }; after: { pack: string; ownLayoutsRemoved: number } }[]>`
      select actor_user_id, before, after from public.audit_log
      where organization_id = ${ORG} and action = 'portal.layout_reset_to_pack'`;
    expect(audit!.actor_user_id).toBe(OWNER);
    expect(audit!.before.blocks).toHaveLength(14);
    expect(audit!.after).toMatchObject({ pack: "hvac", ownLayoutsRemoved: 0 });
    const [layouts] = await raw<{ n: number }[]>`select count(*)::int as n from public.portal_layout
      where organization_id = ${ORG} and is_default and agreement_plan_id is null`;
    expect(layouts!.n).toBe(1);
  });

  it("replaces a layout the company made itself, kept aside when the pack was applied later", async () => {
    /** A company with no pack saves its own page; the pack applied afterwards does not push it aside. */
    const own = await rearranged(as(LATE_ORG, LATE_OWNER));
    expect(own).toMatchObject({ startedFrom: null, changed: true, goBackTo: null });
    await expect(layout.resetToPack(as(LATE_ORG, LATE_OWNER))).rejects.toThrow(/no account page of its own to go back to/);

    await applyTradePack(as(LATE_ORG, LATE_OWNER), "hvac");
    const aside = await layout.get(as(LATE_ORG, LATE_OWNER));
    expect(aside).toMatchObject({ startedFrom: null, changed: true, goBackTo: `${pack.name} portal` });

    const back = await layout.resetToPack(as(LATE_ORG, LATE_OWNER));
    expect(back).toMatchObject({ startedFrom: `${pack.name} portal`, changed: false, goBackTo: null });
    const [audit] = await raw<{ after: { ownLayoutsRemoved: number } }[]>`select after from public.audit_log
      where organization_id = ${LATE_ORG} and action = 'portal.layout_reset_to_pack'`;
    expect(audit!.after.ownLayoutsRemoved).toBe(1);
    expect((await drawn(LATE_ORG, LATE_OWNER))[0]!.kind).toBe(pack.portalBlocks[0]!.kind);
  });

  it("makes the pack's layout again when it is gone, and is refused for a company with no pack", async () => {
    await raw`delete from public.portal_layout where organization_id = ${ORG} and trade_pack_id like 'hvac@%'`;
    expect(await layout.get(as())).toMatchObject({ goBackTo: `${pack.name} portal`, blocks: expect.any(Array) });
    const back = await layout.resetToPack(as());
    expect(back).toMatchObject({ startedFrom: `${pack.name} portal`, changed: false, goBackTo: null });

    await expect(layout.resetToPack(as(BARE_ORG, BARE_OWNER))).rejects.toBeInstanceOf(ConflictError);
    expect((await layout.get(as(BARE_ORG, BARE_OWNER))).goBackTo).toBeNull();
  });

  it("leaves a plan's own page alone, and its screen offers no way back", async () => {
    const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price)
      values (${ORG}, 'Reset Plan', '30.00') returning id`;
    const planRows = posted((await layout.getForPlan(as(), { planId: plan!.id })).blocks)
      .map((r) => (r.kind === "documents" ? { ...r, title: "Member documents" } : r));
    await layout.setForPlan(as(), { planId: plan!.id, blocks: planRows });
    await rearranged(as());
    await layout.resetToPack(as());
    const kept = await layout.getForPlan(as(), { planId: plan!.id });
    expect(kept).toMatchObject({ goBackTo: null });
    expect(kept.blocks.find((b) => b.kind === "documents")!.title).toBe("Member documents");
  });

  it("needs settings:write", async () => {
    await rearranged(as());
    await expect(layout.resetToPack(as(ORG, OWNER, ["technician"]))).rejects.toBeInstanceOf(PermissionError);
    expect(routes.resetPortalLayout.permissions).toEqual(["settings:write"]);
    await layout.resetToPack(as());
  });
});
