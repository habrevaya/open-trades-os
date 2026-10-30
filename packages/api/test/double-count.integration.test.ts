import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { costing as c, type Actor } from "@opentradesos/core";
import * as journals from "../src/services/journals";
import * as profitability from "../src/services/profitability";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M15. A COST THAT MAY BE COUNTED TWICE
 *
 * A cost journalled to a job and the same cost on one of its lines are both in
 * material cost. Nothing can tell for certain whether they are one bill or
 * two, so the job and the margin report say so, and whoever posts journals
 * can mark a pair as two different costs. Neither figure ever moves.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("double-count:org");
const USER = fixtureId("double-count:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...extra,
});
const finance = (extra: Partial<ServiceContext> = {}) => as(["accountant"], extra);

let customerId = "";
let propertyId = "";
let number = 500;

/** Noon in Chicago on a company day, so the line's day is that day in the company's calendar. */
const noonOn = (day: string) => `${day}T17:00:00Z`;

async function job(): Promise<string> {
  number += 1;
  const [row] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status, completed_at)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'Duct run', 'completed', ${noonOn(companyToday(-2))})
    returning id`;
  return (row as { id: string }).id;
}

async function line(jobId: string, input: { name: string; cost: string; on: string; kind?: string; quantity?: string }): Promise<string> {
  const [row] = await raw`insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, unit_cost, occurred_at, non_billable_reason)
    values (${ORG}, ${jobId}, ${input.kind ?? "subcontractor"}, ${input.name}, ${input.quantity ?? "1"}, '0', ${input.cost},
      ${noonOn(input.on)}, 'Included in the price')
    returning id`;
  return (row as { id: string }).id;
}

async function journal(jobId: string, input: { amount: string; on: string; memo: string; lineMemo?: string }) {
  return journals.create(finance(), {
    occurredOn: input.on, memo: input.memo,
    lines: [
      { accountCode: "5000", debit: input.amount, jobId, ...(input.lineMemo ? { memo: input.lineMemo } : {}) },
      { accountCode: "1000", credit: input.amount },
    ],
  });
}

async function costEntryOf(journalId: string): Promise<string> {
  const [row] = await raw`select id from public.ledger_entry where source_id = ${journalId} and account_code = '5000'`;
  return (row as { id: string }).id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Double Count Co", slug: "double-count-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [cust] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Ana Ruiz') returning id`;
  customerId = (cust as { id: string }).id;
  const [prop] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Elm St', 'Austin', 'TX', '78702') returning id`;
  propertyId = (prop as { id: string }).id;
  await raw`insert into public.vendor (organization_id, name) values (${ORG}, 'Ferguson Supply'), (${ORG}, 'Abc')`;
});

run("a cost that may be counted twice", () => {
  it("flags the same amount with dates close, and leaves both in material cost", async () => {
    const jobId = await job();
    const lineId = await line(jobId, { name: "Duct work, subcontractor", cost: "480", on: companyToday(-12) });
    const entry = await journal(jobId, { amount: "480.00", on: companyToday(-8), memo: "Duct bill" });

    const statement = await profitability.statement(finance(), { jobId });
    expect(statement.materialCost).toBe("960.0000");
    expect(statement.possibleDoubleCounts).toBe(1);
    expect(statement.doubleCounts).toHaveLength(1);
    expect(statement.doubleCounts[0]).toMatchObject({
      jobLineId: lineId, journalId: entry.id, journalNumber: entry.number, amount: "480.0000",
      daysApart: 4, sameVendor: null, reason: "Same amount, 4 days apart.", notTheSame: null,
      journalOn: companyToday(-8), lineOn: companyToday(-12),
    });

    /** The margin report counts it, from the same SQL. */
    const summary = await profitability.summary(finance(), { by: "job", includeInProgress: true, from: companyToday(-60) });
    expect(summary.rows).toHaveLength(1);
    expect(Number(summary.rows[0]!["possible_double_counts"])).toBe(1);
    expect(Number(summary.rows[0]!["material_cost"])).toBeCloseTo(960, 2);
  });

  it("flags the same vendor on both however far apart, and nothing that only shares an amount", async () => {
    const jobId = await job();
    await line(jobId, { name: "Ferguson Supply water heater", cost: "900", on: companyToday(-90) });
    await journal(jobId, { amount: "900.00", on: companyToday(-3), memo: "Invoice 4411", lineMemo: "ferguson supply, heater" });
    /** Same amount, long apart, no vendor on both: not flagged. */
    await line(jobId, { name: "Permit", cost: "150", kind: "permit", on: companyToday(-90) });
    await journal(jobId, { amount: "150.00", on: companyToday(-3), memo: "City fee" });
    /** Close in time, different amount: not flagged. */
    await line(jobId, { name: "Disposal", cost: "60", kind: "disposal", on: companyToday(-4) });
    await journal(jobId, { amount: "61.00", on: companyToday(-3), memo: "Dump receipt" });
    /** A short vendor name is a vendor too: "ABC Supply" is a real one. */
    await line(jobId, { name: "Abc fittings", cost: "75", kind: "part", on: companyToday(-90) });
    await journal(jobId, { amount: "75.00", on: companyToday(-3), memo: "abc fittings bill" });

    const statement = await profitability.statement(finance(), { jobId });
    expect(statement.doubleCounts.map((d) => d.lineName)).toEqual(["Ferguson Supply water heater", "Abc fittings"]);
    const ferguson = statement.doubleCounts.find((d) => d.lineName.startsWith("Ferguson"))!;
    expect(ferguson.sameVendor).toBe("Ferguson Supply");
    expect(ferguson.reason).toBe("Same amount, and both name Ferguson Supply (87 days apart).");
    expect(statement.possibleDoubleCounts).toBe(2);
  });

  it("matches a line's quantity times its cost, and a vendor who sells the line's item", async () => {
    const jobId = await job();
    const [item] = await raw`insert into public.price_book_item (organization_id, kind, code)
      values (${ORG}, 'material', 'CAP-45') returning id`;
    const [version] = await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
      values (${ORG}, ${(item as { id: string }).id}, 1, 'Capacitor 45/5', '40', '12.5', now()) returning id`;
    const [vendor] = await raw`select id from public.vendor where organization_id = ${ORG} and name = 'Ferguson Supply'`;
    await raw`insert into public.vendor_item (organization_id, vendor_id, item_id, part_number) values (${ORG}, ${(vendor as { id: string }).id}, ${(item as { id: string }).id}, 'F-4455')`;
    await raw`insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, unit_cost, occurred_at, non_billable_reason, price_book_item_version_id)
      values (${ORG}, ${jobId}, 'part', 'Capacitor 45/5', '4', '40', '12.5', ${noonOn(companyToday(-80))}, 'Included', ${(version as { id: string }).id})`;
    await journal(jobId, { amount: "50.00", on: companyToday(-3), memo: "Ferguson Supply statement" });

    const statement = await profitability.statement(finance(), { jobId });
    expect(statement.doubleCounts).toHaveLength(1);
    expect(statement.doubleCounts[0]).toMatchObject({ amount: "50.0000", sameVendor: "Ferguson Supply" });
  });

  it("does not flag a journal that was reversed, or the reversal", async () => {
    const jobId = await job();
    await line(jobId, { name: "Duct work", cost: "480", on: companyToday(-5) });
    const entry = await journal(jobId, { amount: "480.00", on: companyToday(-4), memo: "Duct bill" });
    await journals.reverse(finance(), { id: entry.id, occurredOn: companyToday(-3) });
    const statement = await profitability.statement(finance(), { jobId });
    expect(statement.doubleCounts).toEqual([]);
    expect(statement.possibleDoubleCounts).toBe(0);
    expect(statement.materialCost).toBe("480.0000");
  });

  it("agrees with the rule in core on every pair it was given", async () => {
    const cases: c.DoubleCountCandidate[] = [
      { lineCost: "480", journalAmount: "480.00", daysApart: 4, sameVendor: null },
      { lineCost: "480", journalAmount: "480.00", daysApart: 31, sameVendor: null },
      { lineCost: "480", journalAmount: "480.00", daysApart: 30, sameVendor: null },
      { lineCost: "480", journalAmount: "480.00", daysApart: -45, sameVendor: "Ferguson Supply" },
      { lineCost: "480", journalAmount: "480.01", daysApart: 0, sameVendor: null },
    ];
    for (const candidate of cases) {
      const jobId = await job();
      const memo = candidate.sameVendor ? `${candidate.sameVendor} bill` : "A bill";
      const name = candidate.sameVendor ? `${candidate.sameVendor} part` : "A part";
      await line(jobId, { name, cost: candidate.lineCost, on: companyToday(-3 - candidate.daysApart) });
      await journal(jobId, { amount: candidate.journalAmount, on: companyToday(-3), memo });
      const statement = await profitability.statement(finance(), { jobId });
      expect(statement.possibleDoubleCounts, JSON.stringify(candidate)).toBe(c.possibleDoubleCount(candidate) ? 1 : 0);
    }
  });
});

run("not the same cost", () => {
  it("takes the warning off, changes no figure, is audited, and can be taken back", async () => {
    const jobId = await job();
    const jobLineId = await line(jobId, { name: "Duct work", cost: "480", on: companyToday(-6) });
    const entry = await journal(jobId, { amount: "480.00", on: companyToday(-5), memo: "Second run of duct" });
    const ledgerEntryId = await costEntryOf(entry.id);

    const mark = await profitability.markNotTheSame(finance({ idempotencyKey: "nts-1" }), {
      jobId, jobLineId, ledgerEntryId, note: "Two runs, two bills",
    });
    expect(mark).toMatchObject({ jobId, jobLineId, ledgerEntryId, note: "Two runs, two bills" });

    const statement = await profitability.statement(finance(), { jobId });
    expect(statement.possibleDoubleCounts).toBe(0);
    expect(statement.materialCost).toBe("960.0000");
    expect(statement.doubleCounts[0]!.notTheSame).toMatchObject({ id: mark.id, note: "Two runs, two bills" });
    const summary = await profitability.summary(finance(), { by: "job", includeInProgress: true, from: companyToday(-60) });
    expect(Number(summary.rows[0]!["possible_double_counts"])).toBe(0);

    /** A retry, by key or by the pair, is the same mark. */
    expect((await profitability.markNotTheSame(finance({ idempotencyKey: "nts-1" }), { jobId, jobLineId, ledgerEntryId })).id).toBe(mark.id);
    expect((await profitability.markNotTheSame(finance(), { jobId, jobLineId, ledgerEntryId })).id).toBe(mark.id);
    const [count] = await raw`select count(*)::int as n from public.job_cost_not_same where organization_id = ${ORG}`;
    expect((count as { n: number }).n).toBe(1);

    const [audited] = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${mark.id}`;
    expect((audited as { action: string }).action).toBe("job_cost.marked_not_the_same");

    await profitability.unmarkNotTheSame(finance(), { jobId, markId: mark.id });
    const after = await profitability.statement(finance(), { jobId });
    expect(after.possibleDoubleCounts).toBe(1);
    expect(after.materialCost).toBe("960.0000");
    const actions = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${mark.id} order by created_at`;
    expect(actions.map((a) => (a as { action: string }).action)).toEqual(["job_cost.marked_not_the_same", "job_cost.not_the_same_removed"]);
    /** Taking back a mark already gone is harmless. */
    await profitability.unmarkNotTheSame(finance(), { jobId, markId: mark.id });
  });

  it("is for whoever posts journals, and only for a pair that is flagged", async () => {
    const jobId = await job();
    const jobLineId = await line(jobId, { name: "Duct work", cost: "480", on: companyToday(-6) });
    const entry = await journal(jobId, { amount: "480.00", on: companyToday(-5), memo: "Duct bill" });
    const ledgerEntryId = await costEntryOf(entry.id);
    const otherLine = await line(jobId, { name: "Grille", cost: "35", kind: "part", on: companyToday(-6) });

    await expect(profitability.markNotTheSame(as(["admin"]), { jobId, jobLineId, ledgerEntryId })).rejects.toThrow();
    await expect(profitability.markNotTheSame(as(["office_manager"]), { jobId, jobLineId, ledgerEntryId })).rejects.toThrow();
    await expect(profitability.markNotTheSame(as(["dispatcher"]), { jobId, jobLineId, ledgerEntryId })).rejects.toThrow();
    await expect(profitability.markNotTheSame(finance(), { jobId, jobLineId: otherLine, ledgerEntryId }))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringMatching(/not flagged/) })] });
    await expect(profitability.markNotTheSame(finance(), { jobId: fixtureId("double-count:nojob"), jobLineId, ledgerEntryId }))
      .rejects.toThrow(/Job/);

    /** The owner posts journals too. */
    await profitability.markNotTheSame(as(["owner"]), { jobId, jobLineId, ledgerEntryId });
    const [count] = await raw`select count(*)::int as n from public.job_cost_not_same where organization_id = ${ORG}`;
    expect((count as { n: number }).n).toBe(1);
  });
});
