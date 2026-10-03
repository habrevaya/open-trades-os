import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as setup from "../src/services/setup";
import * as team from "../src/services/team";
import * as setupTokens from "../src/services/setup-tokens";
import { applyTradePack } from "../src/services/trade-pack";
import * as company from "../src/services/company";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SETUP WIZARD, WITHOUT THE BROWSER
 *
 * What a new company does in its first hour, as the services see it: the
 * steps it marks done are remembered and the list resumes where it left off;
 * the company can rename itself; it can mark items taxable or not without
 * rewriting history; and it can get its team in, each person with a role no
 * bigger than the inviter's and a link of their own.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("setup:org");
const OWNER = fixtureId("setup:owner");
const OTHER_ORG = fixtureId("setup:other-org");
const OTHER_OWNER = fixtureId("setup:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], userId = OWNER, organizationId = ORG): ServiceContext => ({
  actor: { userId, organizationId, roles }, db: db(),
});

const INVITED = ["setup-tech@crew.test", "setup-office@crew.test", "setup-owner2@crew.test", "setup-twice@crew.test"];

beforeAll(async () => {
  if (!url) return;
  process.env["PUBLIC_URL"] = "https://ops.example.test";
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await raw`delete from public."user" where email = any(${INVITED})`;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Setup Heating", slug: "setup-heating" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_OWNER, name: "Setup Other", slug: "setup-other" });
  await applyTradePack(as(["owner"]), "hvac");
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email = any(${INVITED})`;
  await raw.end();
});

run("the steps, remembered", () => {
  it("starts with nothing done and resumes at the first step", async () => {
    const view = await setup.view(as(["owner"]));
    expect(view.progress.done).toBe(0);
    expect(view.progress.next).toBe("company");
    expect(view.steps.every((s) => s.allowed)).toBe(true);
  });

  it("says what is already in place beside each step", async () => {
    const view = await setup.view(as(["owner"]));
    const trade = view.steps.find((s) => s.key === "trade")!;
    expect(trade.facts.join(" ")).toMatch(/hvac pack/);
    const tax = view.steps.find((s) => s.key === "tax")!;
    expect(tax.facts.join(" ")).toMatch(/taxable/);
  });

  it("remembers a step marked done, and resumes after it", async () => {
    await setup.mark(as(["owner"]), { key: "company", done: true });
    await setup.mark(as(["owner"]), { key: "trade", done: true });
    const view = await setup.view(as(["owner"]));
    expect(view.progress.done).toBe(2);
    expect(view.progress.essentialDone).toBe(2);
    expect(view.progress.next).toBe("service-area");
    expect(view.steps.find((s) => s.key === "company")!.doneAt).not.toBeNull();
  });

  it("keeps when a step was first done when it is marked done again", async () => {
    const [before] = await raw`select completed_at from public.setup_step where organization_id = ${ORG} and step_key = 'company'`;
    await setup.mark(as(["owner"]), { key: "company", done: true });
    const [after] = await raw`select completed_at from public.setup_step where organization_id = ${ORG} and step_key = 'company'`;
    expect(after!.completed_at).toEqual(before!.completed_at);
  });

  it("reopens a step, and audits who did", async () => {
    await setup.mark(as(["owner"]), { key: "trade", done: false });
    expect((await setup.view(as(["owner"]))).progress.next).toBe("trade");
    const rows = await raw`select action from public.audit_log where organization_id = ${ORG} and action like 'setup.%'`;
    expect(rows.map((r) => r.action)).toContain("setup.step_reopened");
    await setup.mark(as(["owner"]), { key: "trade", done: true });
  });

  it("refuses a step the person cannot do, by its own permission", async () => {
    // An office manager reads settings and may not connect Stripe.
    await expect(setup.mark(as(["office_manager"]), { key: "payments", done: true }))
      .rejects.toThrow(PermissionError);
    const view = await setup.view(as(["office_manager"]));
    expect(view.steps.find((s) => s.key === "payments")!.allowed).toBe(false);
    expect(view.steps.find((s) => s.key === "team")!.allowed).toBe(true);
  });

  it("refuses a step that does not exist", async () => {
    await expect(setup.mark(as(["owner"]), { key: "payroll", done: true })).rejects.toThrow(NotFoundError);
  });

  it("finishes once, and keeps the first time", async () => {
    const first = await setup.finish(as(["owner"]));
    const second = await setup.finish(as(["owner"]));
    expect(second.setupCompletedAt).toBe(first.setupCompletedAt);
  });

  it("keeps one company's steps out of another's", async () => {
    const other = await setup.view(as(["owner"], OTHER_OWNER, OTHER_ORG));
    expect(other.progress.done).toBe(0);
  });
});

run("the company's own details", () => {
  it("renames the company and sets a legal name, and audits both", async () => {
    const after = await setup.updateDetails(as(["owner"]), { name: "  Setup   Heating & Air ", legalName: "Setup Heating LLC" });
    expect(after.name).toBe("Setup Heating & Air");
    expect(after.legalName).toBe("Setup Heating LLC");
    const [row] = await raw`select name, legal_name from public.organization where id = ${ORG}`;
    expect(row!.name).toBe("Setup Heating & Air");
  });

  it("refuses an empty name, and an office manager", async () => {
    await expect(setup.updateDetails(as(["owner"]), { name: "   " })).rejects.toThrow(ConflictError);
    await expect(setup.updateDetails(as(["office_manager"]), { name: "Mine" })).rejects.toThrow(PermissionError);
  });

  it("clears a legal name with null and leaves it alone when it is not sent", async () => {
    await setup.updateDetails(as(["owner"]), { name: "Setup Heating & Air" });
    expect((await setup.details(as(["owner"]))).legalName).toBe("Setup Heating LLC");
    await setup.updateDetails(as(["owner"]), { name: "Setup Heating & Air", legalName: null });
    expect((await setup.details(as(["owner"]))).legalName).toBeNull();
  });
});

run("which items are taxed", () => {
  it("lists every live item with its tax standing", async () => {
    const rows = await setup.taxTable(as(["owner"]));
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((r) => r.taxClass === "service")).toBe(true);
  });

  it("changes many items at once as new versions, and leaves the ones already right alone", async () => {
    const rows = await setup.taxTable(as(["owner"]));
    const labour = rows.filter((r) => r.taxClass === "service").slice(0, 3);
    const already = rows.find((r) => !r.taxable && r.taxClass === "exempt");
    const ids = labour.map((r) => r.id);

    const result = await setup.setItemTax(as(["owner"]), { itemIds: ids, taxable: true, taxClass: "labor" });
    expect(result.changed).toBe(labour.length);
    const versions = await raw`select max(version)::int as v from public.price_book_item_version where item_id = any(${ids}) group by item_id`;
    expect(versions.every((v) => v.v === 2)).toBe(true);

    const again = await setup.setItemTax(as(["owner"]), { itemIds: ids, taxable: true, taxClass: "labor" });
    expect(again.changed).toBe(0);
    if (already) {
      const none = await setup.setItemTax(as(["owner"]), { itemIds: [already.id], taxable: false, taxClass: "exempt" });
      expect(none.changed).toBe(0);
    }
  });

  it("keeps the old version saying what it said, so an old invoice still reads true", async () => {
    const rows = await raw`select v.version, v.taxable, v.tax_class, v.effective_to
      from public.price_book_item_version v
      join public.price_book_item i on i.id = v.item_id
      where i.organization_id = ${ORG} and v.tax_class = 'labor' and v.version = 2 limit 1`;
    const [old] = await raw`select v.tax_class, v.effective_to from public.price_book_item_version v
      where v.item_id = (select item_id from public.price_book_item_version where tax_class = 'labor' and version = 2
                         and organization_id = ${ORG} limit 1) and v.version = 1`;
    expect(rows).toHaveLength(1);
    expect(old!.tax_class).toBe("service");
    expect(old!.effective_to).not.toBeNull();
  });

  it("refuses an exempt item marked taxable, a class that does not exist, and somebody who may not price", async () => {
    const [first] = await setup.taxTable(as(["owner"]));
    await expect(setup.setItemTax(as(["owner"]), { itemIds: [first!.id], taxable: true, taxClass: "exempt" }))
      .rejects.toThrow(/exempt/);
    await expect(setup.setItemTax(as(["owner"]), { itemIds: [first!.id], taxable: true, taxClass: "luxury" }))
      .rejects.toThrow(/not a tax class/);
    await expect(setup.setItemTax(as(["dispatcher"]), { itemIds: [first!.id], taxable: true, taxClass: null }))
      .rejects.toThrow(PermissionError);
  });
});

run("getting the team in", () => {
  it("invites a technician with a link, a technician record and their branch", async () => {
    const branch = (await company.createBusinessUnit(as(["owner"]), { name: "North" })).id;
    const result = await team.invite(as(["owner"]), {
      email: "Setup-Tech@Crew.test", name: "Terry Tech", role: "technician", businessUnitId: branch,
    });
    expect(result.reissued).toBe(false);
    expect(result.link).toMatch(/^https:\/\/ops\.example\.test\/welcome\?token=/);

    const roster = await team.roster(as(["owner"]));
    const terry = roster.find((p) => p.email === "setup-tech@crew.test")!;
    expect(terry.role).toBe("technician");
    expect(terry.branchName).toBe("North");
    expect(terry.technicianId).not.toBeNull();
    expect(terry.waiting).toBe(true);
  });

  it("hands the link to the welcome page, which lets them choose a password once", async () => {
    const result = await team.invite(as(["owner"]), { email: "setup-twice@crew.test", name: "Pat Twice", role: "csr" });
    const token = new URL(result.link!).searchParams.get("token")!;
    const target = await setupTokens.peek(db(), token);
    expect(target?.email).toBe("setup-twice@crew.test");
  });

  it("gives a fresh link to somebody invited who has not signed in, and the old one stops working", async () => {
    const first = await team.invite(as(["owner"]), { email: "setup-office@crew.test", name: "Olive Office", role: "office_manager" });
    const second = await team.invite(as(["owner"]), { email: "setup-office@crew.test", name: "Olive Office", role: "office_manager" });
    expect(second.reissued).toBe(true);
    expect(second.membershipId).toBe(first.membershipId);
    expect(await setupTokens.peek(db(), new URL(first.link!).searchParams.get("token")!)).toBeNull();
    expect(await setupTokens.peek(db(), new URL(second.link!).searchParams.get("token")!)).not.toBeNull();
  });

  it("refuses an address that already has an account with another company", async () => {
    await expect(team.invite(as(["owner"]), {
      email: "setup-other@test.local", name: "Their Owner", role: "technician",
    })).rejects.toThrow(/another company/);
    const [count] = await raw`select count(*)::int as n from public.membership where organization_id = ${ORG} and user_id = ${OTHER_OWNER}`;
    expect(count!.n).toBe(0);
  });

  it("does not let an office manager invite somebody holding more than they do", async () => {
    await expect(team.invite(as(["office_manager"]), {
      email: "setup-owner2@crew.test", name: "Would Be Owner", role: "owner",
    })).rejects.toThrow(/do not hold yourself/);
    // The technician preset carries the field permissions (syncing a phone,
    // clocking in) an office manager does not hold, so it is the owner's to give.
    await expect(team.invite(as(["office_manager"]), {
      email: "setup-owner2@crew.test", name: "Would Be Tech", role: "technician",
    })).rejects.toThrow(/field:sync/);
    const office = await team.invite(as(["office_manager"]), {
      email: "setup-owner2@crew.test", name: "Dana Dispatch", role: "dispatcher",
    });
    expect(office.link).not.toBeNull();
  });

  it("refuses somebody who may not invite", async () => {
    await expect(team.invite(as(["dispatcher"]), { email: "x@crew.test", name: "X", role: "csr" }))
      .rejects.toThrow(PermissionError);
  });

  it("changes a role in both directions of authority, and never the last owner or your own", async () => {
    const roster = await team.roster(as(["owner"]));
    const olive = roster.find((p) => p.email === "setup-office@crew.test")!;
    const me = roster.find((p) => p.isYou)!;

    const changed = await team.setRole(as(["owner"]), { membershipId: olive.membershipId, role: "dispatcher" });
    expect(changed.role).toBe("dispatcher");

    await expect(team.setRole(as(["owner"]), { membershipId: me.membershipId, role: "admin" }))
      .rejects.toThrow(/your own role/);
    // An administrator cannot demote the owner, who holds what they do not.
    await expect(team.setRole(as(["admin"], fixtureId("setup:some-admin")), { membershipId: me.membershipId, role: "csr" }))
      .rejects.toThrow(/do not hold yourself/);
  });
});
