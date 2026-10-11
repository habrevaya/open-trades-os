import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as layout from "../src/services/portal-layout";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A PAGE OF THEIR OWN FOR THE MEMBERS OF A PLAN
 *
 * A company can give the members of one plan a different account page from
 * everyone else's, arranged in the same editor. With no plan layout the
 * company's is used. The refusals first: a non member, a member of a plan
 * with no layout, a lapsed or pending agreement, another company's plan, and
 * somebody who may not change settings all see or do the company's page.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-plan-layout:org");
const USER = fixtureId("portal-plan-layout:user");
const OTHER_ORG = fixtureId("portal-plan-layout:other-org");
const OTHER_USER = fixtureId("portal-plan-layout:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let gold = "";
let silver = "";
let basic = "";

async function aPlan(name: string, organizationId = ORG) {
  const [p] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price)
    values (${organizationId}, ${name}, '30.00') returning id`;
  return p!.id;
}

async function aMember(name: string, plans: { plan: string; status: string; startedOn: string }[]) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, ${name}) returning id`;
  for (const a of plans) {
    await raw`insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
      values (${ORG}, ${a.plan}, ${c!.id}, ${a.status}, ${a.startedOn}, '30.00', 'monthly')`;
  }
  const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId: c!.id, scope: "customer", expiresInDays: 30,
  }));
  return link.token;
}

const seen = async (token: string) => (await portalAccount.viewAccount(db(), { token })).extras.blocks;
const kinds = (blocks: { kind: string }[]) => blocks.map((b) => b.kind);

/** The plan page: documents first and no equipment. */
const memberPage = async (planId: string, extra: (rows: { kind: string; title: string | null; visible: boolean }[]) => void = () => {}) => {
  const base = await layout.getForPlan(owner(), { planId });
  const rows = base.blocks.map((b) => ({ kind: b.kind, title: b.customTitle, visible: b.kind === "equipment_register" ? false : b.visible }));
  const documents = rows.findIndex((r) => r.kind === "documents");
  const [moved] = rows.splice(documents, 1);
  rows.unshift({ ...moved!, title: "Your member documents", visible: true });
  extra(rows);
  return rows;
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Air", slug: "plan-layout-air" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Member Air", slug: "plan-layout-other" });
  gold = await aPlan("Gold");
  silver = await aPlan("Silver");
  basic = await aPlan("Basic");
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

/* ============================================================ refusals === */

run("a plan's page reaches only its members", () => {
  it("shows the company's page to a non member, to a member of a plan with no page, and to a pending, paused or lapsed agreement", async () => {
    await layout.setForPlan(owner(), { planId: gold, blocks: await memberPage(gold) });
    const company = kinds(await seen(await aMember("Nora Nobody", [])));
    for (const [name, agreement] of [
      ["Sam Silver", { plan: silver, status: "active", startedOn: "2026-01-01" }],
      ["Pat Pending", { plan: gold, status: "pending", startedOn: "2026-01-01" }],
      ["Penny Paused", { plan: gold, status: "paused", startedOn: "2026-01-01" }],
      ["Lou Lapsed", { plan: gold, status: "lapsed", startedOn: "2026-01-01" }],
      ["Cal Cancelled", { plan: gold, status: "cancelled", startedOn: "2026-01-01" }],
    ] as const) {
      expect(kinds(await seen(await aMember(name, [agreement]))), name).toEqual(company);
    }
    // And the company's page is not the plan's.
    const member = kinds(await seen(await aMember("Gail Gold", [{ plan: gold, status: "active", startedOn: "2026-01-01" }])));
    expect(member).not.toEqual(company);
  });

  it("refuses another company's plan as not found, and somebody who may not change settings", async () => {
    const theirs = await aPlan("Theirs", OTHER_ORG);
    await expect(layout.getForPlan(owner(), { planId: theirs })).rejects.toThrow(NotFoundError);
    await expect(layout.setForPlan(owner(), { planId: theirs, blocks: await memberPage(gold) })).rejects.toThrow(NotFoundError);
    await expect(layout.removeForPlan(owner(), { planId: theirs })).rejects.toThrow(NotFoundError);
    await expect(layout.setForPlan(as(["technician"]), { planId: gold, blocks: await memberPage(gold) })).rejects.toThrow(PermissionError);
    await expect(layout.removeForPlan(as(["technician"]), { planId: gold })).rejects.toThrow(PermissionError);
    await expect(layout.getForPlan(as(["technician"]), { planId: gold })).rejects.toThrow(PermissionError);
    await expect(layout.plansWithLayouts(as(["technician"]))).rejects.toThrow(PermissionError);
    const [none] = await raw<{ n: number }[]>`select count(*)::int as n from public.portal_layout where organization_id = ${OTHER_ORG}`;
    expect(none!.n).toBe(0);
  });

  it("refuses hiding the bills on a plan's page, as on the company's", async () => {
    const rows = (await memberPage(basic)).map((r) => (r.kind === "invoices" ? { ...r, visible: false } : r));
    await expect(layout.setForPlan(owner(), { planId: basic, blocks: rows })).rejects.toThrow(ConflictError);
    const [none] = await raw<{ n: number }[]>`select count(*)::int as n from public.portal_layout where agreement_plan_id = ${basic}`;
    expect(none!.n).toBe(0);
  });

  it("never lets a plan's page become the company's, or be a trade pack's", async () => {
    await layout.setForPlan(owner(), { planId: silver, blocks: await memberPage(silver) });
    const [row] = await raw<{ is_default: boolean; trade_pack_id: string | null }[]>`
      select is_default, trade_pack_id from public.portal_layout where agreement_plan_id = ${silver}`;
    expect(row).toEqual({ is_default: false, trade_pack_id: null });
    const company = await layout.get(owner());
    expect(company.plan).toBeNull();
    expect(company.blocks.find((b) => b.kind === "equipment_register")!.visible).toBe(true);
    await layout.removeForPlan(owner(), { planId: silver });
  });
});

/* ===================================================== what it does === */

run("the members of a plan see its page", () => {
  it("draws the plan's page for a member, with its own heading and without what it hid, and the company's for everyone else", async () => {
    await layout.setForPlan(owner(), { planId: gold, blocks: await memberPage(gold) });
    const member = await seen(await aMember("Mia Member", [{ plan: gold, status: "active", startedOn: "2026-02-01" }]));
    expect(member[0]).toMatchObject({ kind: "documents", title: "Your member documents" });
    expect(kinds(member)).not.toContain("equipment_register");

    const other = await seen(await aMember("Ola Other", []));
    expect(kinds(other)).toContain("equipment_register");
    expect(other.find((b) => b.kind === "documents")?.title).not.toBe("Your member documents");

    // A past due member is still a member.
    const behind = await seen(await aMember("Dee Pastdue", [{ plan: gold, status: "past_due", startedOn: "2026-02-01" }]));
    expect(behind[0]).toMatchObject({ kind: "documents", title: "Your member documents" });
  });

  it("starts from the company's layout, keeps its settings, and is saved whole", async () => {
    const view = await layout.getForPlan(owner(), { planId: basic });
    expect(view.plan).toEqual({ id: basic, name: "Basic", ownLayout: false });
    const company = await layout.get(owner());
    expect(view.blocks.map((b) => b.kind)).toEqual(company.blocks.map((b) => b.kind));
    const saved = await layout.setForPlan(owner(), { planId: basic, blocks: await memberPage(basic) });
    expect(saved.plan).toEqual({ id: basic, name: "Basic", ownLayout: true });
    expect(saved.blocks[0]).toMatchObject({ kind: "documents", customTitle: "Your member documents" });
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.portal_block b
      join public.portal_layout l on l.id = b.layout_id where l.agreement_plan_id = ${basic}`;
    expect(count!.n).toBe(company.blocks.length);
    const [audit] = await raw<{ actor_user_id: string }[]>`select actor_user_id from public.audit_log
      where organization_id = ${ORG} and action = 'portal.plan_layout_changed' and entity_id = (select id from public.portal_layout where agreement_plan_id = ${basic})`;
    expect(audit!.actor_user_id).toBe(USER);
    // Saving again is the same layout, not a second.
    await layout.setForPlan(owner(), { planId: basic, blocks: await memberPage(basic, (rows) => { rows[1]!.title = "Second"; }) });
    const [layouts] = await raw<{ n: number }[]>`select count(*)::int as n from public.portal_layout where agreement_plan_id = ${basic}`;
    expect(layouts!.n).toBe(1);
  });

  it("gives a customer on two plans the page of their oldest active agreement", async () => {
    await layout.setForPlan(owner(), { planId: gold, blocks: await memberPage(gold) });
    await layout.setForPlan(owner(), { planId: silver, blocks: await memberPage(silver, (rows) => { rows[0]!.title = "Silver documents"; }) });
    const silverFirst = await seen(await aMember("Both Silver First", [
      { plan: gold, status: "active", startedOn: "2026-06-01" }, { plan: silver, status: "active", startedOn: "2026-01-01" },
    ]));
    expect(silverFirst[0]!.title).toBe("Silver documents");
    const goldFirst = await seen(await aMember("Both Gold First", [
      { plan: gold, status: "active", startedOn: "2025-01-01" }, { plan: silver, status: "active", startedOn: "2026-01-01" },
    ]));
    expect(goldFirst[0]!.title).toBe("Your member documents");
    await layout.removeForPlan(owner(), { planId: silver });
  });

  it("lists the plans with whether they have a page of their own and how many members they have", async () => {
    const { plans } = await layout.plansWithLayouts(owner());
    const byName = new Map(plans.map((p) => [p.name, p]));
    expect(byName.get("Gold")).toMatchObject({ ownLayout: true });
    expect(byName.get("Gold")!.members).toBeGreaterThanOrEqual(2);
    expect(byName.get("Silver")).toMatchObject({ ownLayout: false });
    expect(plans.some((p) => p.name === "Theirs")).toBe(false);
  });

  it("puts the members back on the company's page when it is removed, and removing again changes nothing", async () => {
    await layout.setForPlan(owner(), { planId: gold, blocks: await memberPage(gold) });
    const token = await aMember("Rob Removed", [{ plan: gold, status: "active", startedOn: "2026-03-01" }]);
    expect((await seen(token))[0]!.title).toBe("Your member documents");
    const removed = await layout.removeForPlan(owner(), { planId: gold });
    expect(removed.plan).toEqual({ id: gold, name: "Gold", ownLayout: false });
    expect(kinds(await seen(token))).toContain("equipment_register");
    expect((await seen(token))[0]!.title).not.toBe("Your member documents");
    await expect(layout.removeForPlan(owner(), { planId: gold })).resolves.toMatchObject({ plan: { ownLayout: false } });
    const [gone] = await raw<{ n: number }[]>`select count(*)::int as n from public.portal_block b
      where b.layout_id not in (select id from public.portal_layout) and b.organization_id = ${ORG}`;
    expect(gone!.n).toBe(0);
  });
});
