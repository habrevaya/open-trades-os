import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as layout from "../src/services/portal-layout";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CUSTOMER ON SEVERAL PLANS SEES EACH PLAN'S PAGE (M05, M08)
 *
 * A plan can have an account page of its own. A customer who is a member of two
 * plans that each have one used to see only the oldest agreement's, and the
 * other plan's page was out of reach. Now the account lists their plan pages and
 * they choose: the oldest agreement's is still the one they land on, so the
 * page does not change from one visit to the next, and asking for a plan they
 * are not a member of is the page they would have got anyway.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-plan-pages:org");
const USER = fixtureId("portal-plan-pages:user");
const OTHER_ORG = fixtureId("portal-plan-pages:other-org");
const OTHER_USER = fixtureId("portal-plan-pages:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const owner = () => as();

let gold = "";
let silver = "";
let bronze = "";
let plain = "";

async function aPlan(name: string, organizationId = ORG) {
  const [p] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price)
    values (${organizationId}, ${name}, '30.00') returning id`;
  return p!.id;
}

type Agreement = { plan: string; status: string; startedOn: string };

async function aMember(name: string, agreements: Agreement[]) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, ${name}) returning id`;
  for (const a of agreements) {
    await raw`insert into public.agreement (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
      values (${ORG}, ${a.plan}, ${c!.id}, ${a.status}, ${a.startedOn}, '30.00', 'monthly')`;
  }
  const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId: c!.id, scope: "customer", expiresInDays: 30,
  }));
  return link.token;
}

/** A plan's page: documents first under the plan's own heading, and the named blocks hidden. */
async function givePage(planId: string, heading: string, hide: string[]) {
  const base = await layout.getForPlan(owner(), { planId });
  const rows = base.blocks.map((b) => ({ kind: b.kind, title: b.customTitle, visible: hide.includes(b.kind) ? false : b.visible }));
  const documents = rows.findIndex((r) => r.kind === "documents");
  const [moved] = rows.splice(documents, 1);
  rows.unshift({ ...moved!, title: heading, visible: true });
  await layout.setForPlan(owner(), { planId, blocks: rows });
}

const view = (token: string, plan?: string) => portalAccount.viewAccount(db(), plan ? { token, plan } : { token });
const heading = (account: Awaited<ReturnType<typeof view>>) => account.extras.blocks[0]!.title;
const kinds = (account: Awaited<ReturnType<typeof view>>) => account.extras.blocks.map((b) => b.kind);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Member Air", slug: "plan-pages-air" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Member Air", slug: "plan-pages-other" });
  gold = await aPlan("Gold");
  silver = await aPlan("Silver");
  bronze = await aPlan("Bronze");
  plain = await aPlan("Plain");
  await givePage(gold, "Gold documents", ["equipment_register"]);
  await givePage(silver, "Silver documents", ["next_visit"]);
  await givePage(bronze, "Bronze documents", []);
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

run("a customer on several plans", () => {
  const both = (): Agreement[] => [
    { plan: silver, status: "active", startedOn: "2026-06-01" },
    { plan: gold, status: "active", startedOn: "2026-01-01" },
  ];

  it("lands on the oldest agreement's page, as before, and is offered each plan's page", async () => {
    const token = await aMember("Ann Both", both());
    const account = await view(token);
    expect(heading(account)).toBe("Gold documents");
    expect(account.extras.pages).toEqual([{ planId: gold, name: "Gold" }, { planId: silver, name: "Silver" }]);
    expect(account.extras.page).toBe(gold);
  });

  it("shows the other plan's page, with its own layout, when they choose it", async () => {
    const token = await aMember("Bea Both", both());
    const gold$ = await view(token, gold);
    const silver$ = await view(token, silver);
    expect(heading(gold$)).toBe("Gold documents");
    expect(heading(silver$)).toBe("Silver documents");
    expect(kinds(gold$)).not.toContain("equipment_register");
    expect(kinds(silver$)).toContain("equipment_register");
    expect(kinds(silver$)).not.toContain("next_visit");
    expect(kinds(gold$)).toContain("next_visit");
    expect(silver$.extras.page).toBe(silver);
    /** The list does not change with the page, so the customer can always get back. */
    expect(silver$.extras.pages).toEqual(gold$.extras.pages);
  });

  it("is the same page on the next visit: the oldest agreement's, whatever they looked at last", async () => {
    const token = await aMember("Cy Both", both());
    await view(token, silver);
    expect(heading(await view(token))).toBe("Gold documents");
  });

  it("falls back to the page they would have had for a plan they are not a member of, and says nothing about it", async () => {
    const token = await aMember("Di Both", both());
    const usual = await view(token);
    const theirs = await aPlan("Theirs", OTHER_ORG);
    for (const asked of [bronze, plain, theirs, "00000000-0000-4000-8000-000000000000"]) {
      const account = await view(token, asked);
      expect(heading(account), asked).toBe("Gold documents");
      expect(account.extras.page).toBe(gold);
      expect(kinds(account)).toEqual(kinds(usual));
    }
  });

  it("counts only agreements that make them a member: active and past due, not pending, paused, lapsed or cancelled", async () => {
    for (const status of ["pending", "paused", "lapsed", "cancelled"]) {
      const token = await aMember(`Ed ${status}`, [
        { plan: gold, status: "active", startedOn: "2026-01-01" },
        { plan: silver, status, startedOn: "2026-02-01" },
      ]);
      const account = await view(token, silver);
      expect(account.extras.pages, status).toEqual([]);
      expect(heading(account), status).toBe("Gold documents");
    }
    const behind = await aMember("Flo Pastdue", [
      { plan: gold, status: "active", startedOn: "2026-01-01" },
      { plan: silver, status: "past_due", startedOn: "2026-02-01" },
    ]);
    expect((await view(behind, silver)).extras.pages.map((p) => p.name)).toEqual(["Gold", "Silver"]);
    expect(heading(await view(behind, silver))).toBe("Silver documents");
  });

  it("is offered one entry for a plan however many agreements they hold on it", async () => {
    const token = await aMember("Gus Twice", [
      { plan: gold, status: "active", startedOn: "2026-01-01" },
      { plan: gold, status: "active", startedOn: "2026-03-01" },
      { plan: silver, status: "active", startedOn: "2026-02-01" },
    ]);
    expect((await view(token)).extras.pages).toEqual([{ planId: gold, name: "Gold" }, { planId: silver, name: "Silver" }]);
  });

  it("is offered three pages in the order of their agreements", async () => {
    const token = await aMember("Hal Three", [
      { plan: bronze, status: "active", startedOn: "2026-03-01" },
      { plan: silver, status: "active", startedOn: "2026-02-01" },
      { plan: gold, status: "active", startedOn: "2026-01-01" },
    ]);
    expect((await view(token)).extras.pages.map((p) => p.name)).toEqual(["Gold", "Silver", "Bronze"]);
    expect(heading(await view(token, bronze))).toBe("Bronze documents");
  });
});

run("a customer with nothing to choose between", () => {
  it("is offered no choice on one plan with a page, and sees it", async () => {
    const token = await aMember("Ivy One", [{ plan: gold, status: "active", startedOn: "2026-01-01" }]);
    const account = await view(token);
    expect(account.extras.pages).toEqual([]);
    expect(account.extras.page).toBe(gold);
    expect(heading(account)).toBe("Gold documents");
  });

  it("is offered no choice with a second plan that has no page of its own, and sees the page they have", async () => {
    const token = await aMember("Jo Plain", [
      { plan: plain, status: "active", startedOn: "2026-01-01" },
      { plan: silver, status: "active", startedOn: "2026-02-01" },
    ]);
    const account = await view(token);
    expect(account.extras.pages).toEqual([]);
    expect(heading(account)).toBe("Silver documents");
  });

  it("sees the company's page, and no page of a plan, as a non member", async () => {
    const token = await aMember("Kai Nobody", []);
    const account = await view(token, gold);
    expect(account.extras.pages).toEqual([]);
    expect(account.extras.page).toBeNull();
    expect(heading(account)).not.toBe("Gold documents");
    expect(kinds(account)).toContain("equipment_register");
  });

  it("is told of a plan's page only while its page exists", async () => {
    const token = await aMember("Lee Removed", [
      { plan: gold, status: "active", startedOn: "2026-01-01" },
      { plan: bronze, status: "active", startedOn: "2026-02-01" },
    ]);
    expect((await view(token)).extras.pages.map((p) => p.name)).toEqual(["Gold", "Bronze"]);
    await layout.removeForPlan(owner(), { planId: bronze });
    const after = await view(token, bronze);
    expect(after.extras.pages).toEqual([]);
    expect(heading(after)).toBe("Gold documents");
    await givePage(bronze, "Bronze documents", []);
  });
});
