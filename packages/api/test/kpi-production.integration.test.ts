import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import { type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * PRODUCTION PER CREW HOUR, AND THE MOBILISATION IT WAITED ON
 *
 * Lawn and landscape's "production units completed, in the unit on the job
 * type, divided by crew hours on site", leaving out drive time and the
 * mobilisation on a build's first day. Loading, driving out and unloading was
 * punched as on site time. The timeclock has a kind for it now, getting a job
 * ready, paid exactly as on site time and read only by this figure, and a
 * job's amount of work is set on its page.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-production:org");
const OWNER = fixtureId("kpi-production:owner");
const ANA = fixtureId("kpi-production:ana");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let customerId = "";
let propertyId = "";
let seq = 0;
const tech = { ana: "", ben: "" };
const type = { install: "", mulch: "", maint: "", yard: "" };

const instant = (local: string) => raw.unsafe(`('${local}'::timestamp at time zone '${ZONE}')`);

async function jobType(name: string, code: string, revenueClass: string, unit: string | null): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class, production_unit)
    values (${ORG}, ${name}, ${code}, 'crew_production', ${revenueClass}::job_revenue_class, ${unit}) returning id`;
  return row!.id;
}

/** A job of a type, completed at five in the afternoon on a day, with one visit; its amount of work set through the service. */
async function job(typeId: string, day: string, quantity: string | null): Promise<{ jobId: string; visitId: string }> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${typeId}, 'completed', ${`Build ${seq}`}, ${instant(`${day} 17:00`)}) returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, completed_at)
    values (${ORG}, ${row!.id}, 1, 'completed', ${instant(`${day} 17:00`)}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${visit!.id}, ${tech.ana}, true)`;
  if (quantity !== null) await jobs.update(owner(), { id: row!.id, productionQuantity: quantity });
  return { jobId: row!.id, visitId: visit!.id };
}

/** A closed punch on a job: a person, a kind, a local start and how many hours. */
async function punch(jobId: string, technicianId: string, kind: string, start: string, hours: number | null): Promise<void> {
  const ended = hours === null ? null : raw.unsafe(`(('${start}'::timestamp + interval '${hours * 60} minutes') at time zone '${ZONE}')`);
  await raw`
    insert into public.timeclock_entry (organization_id, technician_id, kind, job_id, started_at, ended_at, minutes)
    values (${ORG}, ${technicianId}, ${kind}::time_entry_kind, ${jobId}, ${instant(start)}, ${ended}, ${hours === null ? null : Math.round(hours * 60)})`;
}

async function technician(name: string, userId: string | null): Promise<string> {
  let user = userId;
  if (!user) {
    const [u] = await raw<{ id: string }[]>`insert into public."user" (email, name) values (${`${name}-${crypto.randomUUID()}@kpi-production.test`}, ${name}) returning id`;
    user = u!.id;
  }
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${user}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

const ana = () => as(ANA, ["technician"], { technicianId: tech.ana });
let device = "";
let sequence = 0;
async function fromThePhone(kind: "timeclock.punch_in" | "timeclock.punch_out", at: string, subjectId?: string, payload: Record<string, unknown> = {}) {
  sequence += 1;
  const result = await fieldOps.sync(ana(), {
    deviceId: device,
    operations: [{ clientId: crypto.randomUUID(), sequence, kind, ...(subjectId ? { subjectId } : {}), occurredAt: at, payload }],
  });
  return result.results[0]!;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  sequence = 0;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Production Co", slug: "kpi-production-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'lawn-and-landscape' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Lee Lawn') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '3 Sod Lane', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  type.install = await jobType("Landscape install", "install", "install", "square feet");
  type.mulch = await jobType("Mulch refresh", "mulch", "project", "cubic yards");
  type.maint = await jobType("Weekly mowing", "maint", "recurring", null);
  type.yard = await jobType("Yard sod cutting", "yard", "internal", "square feet");

  await raw`delete from public."user" where id = ${ANA}`;
  await raw`insert into public."user" (id, email, name) values (${ANA}, 'ana@kpi-production.test', 'Ana')`;
  tech.ana = await technician("Ana", ANA);
  tech.ben = await technician("Ben", null);
  device = (await fieldOps.register(ana(), { installationId: `ana-${crypto.randomUUID()}` })).deviceId;
});

/**
 * June, by hand.
 *
 *   J1 install, 1200 sq ft, done Jun 10. Jun 9: Ana and Ben get it ready 2 h
 *      each, Ben drives 1 h. Jun 9 and 10: Ana on site 7.5 h and a paid break
 *      0.5 h, Ben on site 8 h.                                     1200 over 16 h
 *   J2 install, 800 sq ft, Jun 20: Ana 5 h and Ben 5 h on site.        800 over 10 h
 *   J3 mulch, 12 cubic yards, Jun 15: 4 h on site.                another unit, beside
 *   J4 install, no amount recorded, Jun 21: 3 h on site.         not known, beside
 *   J5 install, 500 sq ft, Jun 22: only 2 h getting it ready.    not known, beside
 *   J6 install, 400 sq ft, Jun 23: 2 h, and somebody still on.  not known, beside
 *   J7 yard work (internal), J8 mowing (no unit)                 not production work
 *   J9 install, 1000 sq ft, Jul 1                                 another month
 *
 *   Square feet had 26 hours to cubic yards' 4, so the figure is in square feet:
 *   2000 / 26 = 76.92 a crew hour.
 */
async function june(): Promise<Record<string, { jobId: string; visitId: string }>> {
  const j: Record<string, { jobId: string; visitId: string }> = {};
  j.J1 = await job(type.install, "2026-06-10", "1200");
  await punch(j.J1.jobId, tech.ana, "mobilisation", "2026-06-09 07:00", 2);
  await punch(j.J1.jobId, tech.ben, "mobilisation", "2026-06-09 07:00", 2);
  await punch(j.J1.jobId, tech.ben, "travel", "2026-06-09 09:00", 1);
  await punch(j.J1.jobId, tech.ana, "on_site", "2026-06-09 10:00", 4);
  await punch(j.J1.jobId, tech.ana, "paid_break", "2026-06-09 14:00", 0.5);
  await punch(j.J1.jobId, tech.ana, "on_site", "2026-06-10 07:00", 3.5);
  await punch(j.J1.jobId, tech.ben, "on_site", "2026-06-10 07:00", 8);
  j.J2 = await job(type.install, "2026-06-20", "800");
  await punch(j.J2.jobId, tech.ana, "on_site", "2026-06-20 07:00", 5);
  await punch(j.J2.jobId, tech.ben, "on_site", "2026-06-20 07:00", 5);
  j.J3 = await job(type.mulch, "2026-06-15", "12");
  await punch(j.J3.jobId, tech.ana, "on_site", "2026-06-15 07:00", 4);
  j.J4 = await job(type.install, "2026-06-21", null);
  await punch(j.J4.jobId, tech.ana, "on_site", "2026-06-21 07:00", 3);
  j.J5 = await job(type.install, "2026-06-22", "500");
  await punch(j.J5.jobId, tech.ana, "mobilisation", "2026-06-22 07:00", 2);
  j.J6 = await job(type.install, "2026-06-23", "400");
  await punch(j.J6.jobId, tech.ana, "on_site", "2026-06-23 07:00", 2);
  await punch(j.J6.jobId, tech.ben, "on_site", "2026-06-23 07:00", null);
  j.J7 = await job(type.yard, "2026-06-24", "900");
  await punch(j.J7.jobId, tech.ana, "on_site", "2026-06-24 07:00", 3);
  j.J8 = await job(type.maint, "2026-06-25", null);
  await punch(j.J8.jobId, tech.ana, "on_site", "2026-06-25 07:00", 1);
  j.J9 = await job(type.install, "2026-07-01", "1000");
  await punch(j.J9.jobId, tech.ana, "on_site", "2026-07-01 07:00", 5);
  return j;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "production_per_crew_hour")!;

run("production per crew hour", () => {
  it("is units of work over crew hours on site, without the drive or getting the job ready, worked by hand", async () => {
    await june();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["2000", "26", "76.92"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "excluded", count: "1" }),
      expect.objectContaining({ key: "unknown", count: "3" }),
    ]);

    const units = await kpis.drill(owner(), { key: "production_per_crew_hour", half: "numerator", ...WINDOW });
    expect(units.records.map((r) => [r.label, Number(r.value)])).toEqual([
      ["#2 Build 2: 800 square feet over 10.00 hours on site", 800],
      ["#1 Build 1: 1200 square feet over 16.00 hours on site, 4.00 getting it ready left out", 1200],
    ]);
    expect(units.records.every((r) => r.kind === "job" && r.href.startsWith("/jobs/"))).toBe(true);
    const hours = await kpis.drill(owner(), { key: "production_per_crew_hour", half: "denominator", ...WINDOW });
    expect(hours.total).toBe("26.0000");
    const other = await kpis.drill(owner(), { key: "production_per_crew_hour", half: "excluded", ...WINDOW });
    expect(other.records.map((r) => r.label)).toEqual(["#3 Build 3: 12 cubic yards over 4.00 hours, 3.00 an hour, measured in another unit"]);
    const unknown = await kpis.drill(owner(), { key: "production_per_crew_hour", half: "unknown", ...WINDOW });
    expect(unknown.records.map((r) => r.label)).toEqual([
      "#6 Build 6: somebody is still on the clock on it",
      "#5 Build 5: no hours on site punched",
      "#4 Build 4: no amount of work recorded",
    ]);
  });

  it("puts the same jobs through core's rule and gets the same answer", async () => {
    await june();
    const rows = await raw<{ id: string; unit: string; quantity: string | null }[]>`
      select j.id, jt.production_unit as unit, j.production_quantity as quantity
      from public.job j join public.job_type jt on jt.id = j.job_type_id
      where j.organization_id = ${ORG} and jt.production_unit is not null and jt.revenue_class <> 'internal'
        and j.completed_at >= ${instant("2026-06-01 00:00")} and j.completed_at < ${instant("2026-07-01 00:00")}`;
    const punches = await raw<{ job_id: string; kind: string; minutes: number | null }[]>`
      select job_id, kind::text as kind, minutes from public.timeclock_entry where organization_id = ${ORG}`;
    const verdict = reporting.productionPerCrewHour(rows.map((r) => ({
      unit: r.unit, quantity: r.quantity === null ? null : Number(r.quantity),
      punches: punches.filter((p) => p.job_id === r.id).map((p) => ({ kind: p.kind, minutes: p.minutes })),
    })));
    const kpi = await figure();
    expect(verdict.unitKey).toBe("square feet");
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([verdict.units, verdict.hours]);
    expect(kpi.besides!.map((b) => Number(b.count))).toEqual([verdict.otherUnit, verdict.notKnown]);
  });
});

run("getting a job ready, on the phone", () => {
  it("is a punch of its own kind on the stop's job, told back to the phone, and a kind nobody knows is refused", async () => {
    const { jobId, visitId } = await job(type.install, "2026-06-10", "100");
    expect(await fromThePhone("timeclock.punch_in", "2026-06-10T12:00:00Z", visitId, { kind: "mobilisation" }))
      .toMatchObject({ status: "applied" });
    const [entry] = await raw<{ kind: string; job_id: string; visit_id: string }[]>`
      select kind::text as kind, job_id, visit_id from public.timeclock_entry where technician_id = ${tech.ana}`;
    expect(entry).toEqual({ kind: "mobilisation", job_id: jobId, visit_id: visitId });

    const snapshot = await dispatch.snapshot(ana(), { deviceId: device, from: "2026-06-10", days: 1 });
    expect(snapshot.openTimeEntry).toMatchObject({ kind: "mobilisation", visitId });

    expect(await fromThePhone("timeclock.punch_out", "2026-06-10T14:00:00Z")).toMatchObject({ status: "applied" });
    const refused = await fromThePhone("timeclock.punch_in", "2026-06-10T15:00:00Z", undefined, { kind: "napping" });
    expect(refused.status).toBe("rejected");
    expect(refused.rejection).toMatch(/not one this product knows/);
    /** An ordinary clock in is on site time on no job, as it always was. */
    expect(await fromThePhone("timeclock.punch_in", "2026-06-10T15:00:00Z")).toMatchObject({ status: "applied" });
    const kinds = await raw<{ kind: string; job_id: string | null }[]>`
      select kind::text as kind, job_id from public.timeclock_entry where technician_id = ${tech.ana} order by started_at`;
    expect(kinds).toEqual([{ kind: "mobilisation", job_id: jobId }, { kind: "on_site", job_id: null }]);
  });
});

run("a job's amount of work", () => {
  it("is set on the job in its type's unit, audited, read beside its hours, and refused when it is not an amount", async () => {
    const { jobId } = await job(type.install, "2026-06-10", "1500");
    await punch(jobId, tech.ana, "on_site", "2026-06-10 07:00", 6);
    await punch(jobId, tech.ana, "mobilisation", "2026-06-09 07:00", 1.5);
    expect(await jobs.production(owner(), { id: jobId })).toEqual({
      unit: "square feet", quantity: "1500.0000", onSiteHours: "6.00", readyHours: "1.50", punchStillRunning: false,
    });
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'job.updated' and entity_id = ${jobId}`;
    expect(audited.length).toBe(1);

    await expect(jobs.update(owner(), { id: jobId, productionQuantity: "0" })).rejects.toThrow(/amount of work/);
    await jobs.update(owner(), { id: jobId, productionQuantity: null });
    expect((await jobs.production(owner(), { id: jobId }))?.quantity).toBeNull();

    const mowing = await job(type.maint, "2026-06-10", null);
    expect(await jobs.production(owner(), { id: mowing.jobId })).toBeNull();
  });
});
