import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { costing as c, money as m, type Actor } from "@opentradesos/core";
import * as costing from "../src/services/costing";
import * as profitability from "../src/services/profitability";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M15. OVERHEAD BY MATERIAL COST, BY THE VISIT AND BY THE TRUCK
 *
 * The figures, worked by hand, for one job finished on 2026-08-20:
 *
 *   material cost      600.00   a 400 part and a 200 subcontractor line
 *   visits                  3   three visits, a fourth cancelled
 *   truck days              3   Van 1 with Sam on the 18th and the 19th,
 *                               Van 2 with Lee on the 19th; Lee's other van
 *                               is retired from his hands before the 18th
 *   overhead, 5% material  30.00
 *   overhead, 15 a visit   45.00
 *   overhead, 40 a truck  120.00
 *   overhead             195.00
 *
 * And the SQL is held to `costing.overheadParts` in core for the same job.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("overhead-bases:org");
const USER = fixtureId("overhead-bases:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let sam = "";
let lee = "";
let number = 700;

async function technician(name: string): Promise<string> {
  const [membership] = await raw`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${(membership as { id: string }).id}, ${name}) returning id`;
  return (t as { id: string }).id;
}

async function vehicle(label: string): Promise<string> {
  const [a] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'vehicle', ${label}) returning id`;
  return (a as { id: string }).id;
}

async function held(assetId: string, kind: "technician" | "job", by: string, from: string, until: string | null) {
  await raw`insert into public.asset_custody (organization_id, asset_id, custodian_kind, custodian_id, held_from, held_until)
    values (${ORG}, ${assetId}, ${kind}, ${by}, ${from}, ${until})`;
}

async function job(input: { status?: string; completedAt?: string } = {}): Promise<string> {
  number += 1;
  const [row] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status, completed_at)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'Boiler swap', ${input.status ?? "completed"},
      ${input.completedAt ?? "2026-08-20T20:00:00Z"})
    returning id`;
  return (row as { id: string }).id;
}

async function visit(jobId: string, on: string, who: string[], status = "completed"): Promise<string> {
  const [v] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${jobId}, ${status}, ${`${on}T15:00:00Z`}, ${`${on}T18:00:00Z`}) returning id`;
  const visitId = (v as { id: string }).id;
  for (const technicianId of who) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visitId}, ${technicianId})`;
  }
  return visitId;
}

async function line(jobId: string, kind: string, cost: string) {
  await raw`insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, unit_cost, non_billable_reason, occurred_at)
    values (${ORG}, ${jobId}, ${kind}, ${kind}, 1, 0, ${cost}, 'In the price', '2026-08-18T16:00:00Z')`;
}

/** The job in the header: three visits and a cancelled one, two vans, 600 of material. */
async function boilerJob(): Promise<string> {
  const jobId = await job();
  await line(jobId, "part", "400");
  await line(jobId, "subcontractor", "200");
  await visit(jobId, "2026-08-18", [sam]);
  await visit(jobId, "2026-08-19", [sam, lee]);
  await visit(jobId, "2026-08-19", [sam]);
  await visit(jobId, "2026-08-21", [sam, lee], "cancelled");
  const van1 = await vehicle("Van 1");
  const van2 = await vehicle("Van 2");
  const van3 = await vehicle("Van 3");
  await held(van1, "technician", sam, "2026-01-01", null);
  await held(van2, "technician", lee, "2026-08-19", "2026-08-31");
  await held(van3, "technician", lee, "2026-01-01", "2026-08-17");
  /** A trailer is not a truck, however long somebody holds it. */
  const [trailer] = await raw`insert into public.company_asset (organization_id, kind, label) values (${ORG}, 'trailer', 'Trailer') returning id`;
  await held((trailer as { id: string }).id, "technician", sam, "2026-01-01", null);
  return jobId;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.asset_custody where organization_id = ${ORG}`;
  await raw`delete from public.company_asset where organization_id = ${ORG}`;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Overhead Bases Co", slug: "overhead-bases-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [cust] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Mo Patel') returning id`;
  customerId = (cust as { id: string }).id;
  const [prop] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Main St', 'Austin', 'TX', '78701') returning id`;
  propertyId = (prop as { id: string }).id;
  sam = await technician("Sam Ortiz");
  lee = await technician("Lee Wong");
});

run("overhead by material cost, by the visit and by the truck", () => {
  it("charges each part its own way and reports each on its own", async () => {
    await costing.setOverhead(owner(), {
      effectiveFrom: "2026-01-01", percentOfMaterial: "5", perVisit: "15", perTruck: "40",
    });
    const jobId = await boilerJob();
    const statement = await profitability.statement(owner(), { jobId });
    expect(statement.materialCost).toBe("600.0000");
    expect(statement.overheadMeasures).toEqual({ visits: 3, truckDays: 3 });
    expect(statement.overheadParts).toMatchObject({
      perHour: "0.0000", perJob: "0.0000", revenueShare: "0.0000",
      materialShare: "30.0000", perVisit: "45.0000", perTruck: "120.0000",
    });
    expect(statement.overhead).toBe("195.0000");
    expect(statement.fullyLoadedMargin).toBe(m.toString(m.subtract(m.money(statement.grossMargin), m.money("195"))));

    /** Core gives the same parts for the same job. */
    const rates = (await costing.list(owner())).rates.map((r) => ({
      component: r.component, basis: r.basis, rate: r.rate, effectiveFrom: r.effectiveFrom,
    }));
    const parts = c.overheadParts({
      date: "2026-08-20", minutes: 0, revenue: m.money("0"), materialCost: m.money("600"), visits: 3, truckDays: 3,
    }, rates);
    expect(m.toString(parts.materialShare)).toBe(statement.overheadParts.materialShare);
    expect(m.toString(parts.perVisit)).toBe(statement.overheadParts.perVisit);
    expect(m.toString(parts.perTruck)).toBe(statement.overheadParts.perTruck);
    expect(m.toString(parts.total)).toBe(statement.overhead);

    /** The margin report carries each part as a measure, which add up to the overhead. */
    const summary = await profitability.summary(owner(), { by: "job", includeInProgress: true, from: "2026-01-01" });
    const row = summary.rows[0] as Record<string, unknown>;
    expect(Number(row["overhead_material_share"])).toBeCloseTo(30, 2);
    expect(Number(row["overhead_per_visit"])).toBeCloseTo(45, 2);
    expect(Number(row["overhead_per_truck"])).toBeCloseTo(120, 2);
    expect(Number(row["overhead"])).toBeCloseTo(195, 2);
  });

  it("counts a truck the job itself held, and none for a visit nobody recorded a truck for", async () => {
    await costing.setOverhead(owner(), { effectiveFrom: "2026-01-01", perTruck: "40" });
    const jobId = await job();
    await visit(jobId, "2026-08-18", [lee]);
    const none = await profitability.statement(owner(), { jobId });
    expect(none.overheadMeasures.truckDays).toBe(0);
    expect(none.overhead).toBe("0.0000");

    const crane = await vehicle("Crane truck");
    await held(crane, "job", jobId, "2026-08-18", "2026-08-18");
    const one = await profitability.statement(owner(), { jobId });
    expect(one.overheadMeasures.truckDays).toBe(1);
    expect(one.overheadParts.perTruck).toBe("40.0000");
  });

  it("is mixed with the first three, replaced whole on a later day, and none on a cancelled job", async () => {
    await costing.setOverhead(owner(), { effectiveFrom: "2026-01-01", perJob: "25", perVisit: "10" });
    await costing.setOverhead(owner(), { effectiveFrom: "2026-08-01", percentOfMaterial: "10" });
    const july = await job({ completedAt: "2026-07-15T18:00:00Z" });
    await line(july, "part", "100");
    await visit(july, "2026-07-15", [sam]);
    const august = await boilerJob();
    expect((await profitability.statement(owner(), { jobId: july })).overheadParts)
      .toMatchObject({ perJob: "25.0000", perVisit: "10.0000", materialShare: "0.0000" });
    expect((await profitability.statement(owner(), { jobId: august })).overheadParts)
      .toMatchObject({ perJob: "0.0000", perVisit: "0.0000", materialShare: "60.0000" });

    const cancelled = await job({ status: "cancelled" });
    await line(cancelled, "part", "100");
    expect((await profitability.statement(owner(), { jobId: cancelled })).overhead).toBe("0.0000");
  });

  it("reads back today's mix with the new parts, and takes one rate at a time too", async () => {
    await costing.setOverhead(owner(), { effectiveFrom: "2026-01-01", perHour: "12", perTruck: "40" });
    await costing.set(owner(), { component: "overhead", basis: "per_visit", rate: "15", effectiveFrom: "2026-01-01" });
    const listed = await costing.list(owner());
    expect(listed.overheadNow!.parts.map((p) => [p.basis, p.rate])).toEqual([
      ["per_hour", "12"], ["per_visit", "15"], ["per_truck", "40"],
    ]);
    expect(listed.rates.find((r) => r.basis === "per_truck")!.basisLabel).toBe("Per truck, each day it went out on the job");
    await expect(costing.set(owner(), { component: "workers_comp", basis: "per_visit", rate: "1", effectiveFrom: "2026-02-01" }))
      .rejects.toThrow(/cannot be saved/);
    await expect(costing.setOverhead(owner(), { effectiveFrom: "2026-03-01", percentOfMaterial: "120" }))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ path: "percentOfMaterial" })] });
    await expect(costing.setOverhead(as(["office_manager"]), { effectiveFrom: "2026-03-01", perVisit: "5" })).rejects.toThrow();
  });
});
