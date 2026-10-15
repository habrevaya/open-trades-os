import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import * as visits from "../src/services/visits";
import * as visitChanges from "../src/services/visit-changes";
import * as cancellations from "../src/services/visit-cancellations";
import * as portal from "../src/services/portal";
import { ConflictError, UnprocessableError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * CANCELLATION RATE BY ROUTE, AND WHO CALLED A VISIT OFF
 *
 * Cleaning's "stops cancelled or skipped inside the notice window divided by
 * stops scheduled, reported per route and per weekday. EXCLUDES visits the
 * company cancelled for weather or staffing, which are a separate and more
 * serious number." A cancelled visit said neither who nor when; every path
 * that cancels one now says both, with the company's notice window frozen on
 * it, and the figure reads them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-cancel:org");
const USER = fixtureId("kpi-cancel:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let routeId = "";
let crewId = "";
let seq = 0;
const types = new Map<string, string>();

async function typeOf(revenueClass: string): Promise<string> {
  const found = types.get(revenueClass);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, ${revenueClass}, ${`cr-${revenueClass}`}, 'route', ${revenueClass}::job_revenue_class) returning id`;
  types.set(revenueClass, row!.id);
  return row!.id;
}

/** A local wall clock time in Austin as an instant. */
const local = (day: string, clock: string) => raw.unsafe(`('${day} ${clock}'::timestamp at time zone '${ZONE}')`);

/**
 * A stop: a job with one visit, at nine on `day`, and how it was called off.
 * `askedHoursBefore` is how long before nine the customer (or company) asked;
 * negative is after the window began.
 */
async function stop(name: string, opts: {
  day?: string | null; status?: string; by?: "customer" | "company" | null;
  askedHoursBefore?: number; notice?: number; revenueClass?: string; onRoute?: boolean;
} = {}): Promise<string> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${await typeOf(opts.revenueClass ?? "recurring")}, 'scheduled', ${name})
    returning id`;
  const day = opts.day === undefined ? "2026-06-10" : opts.day;
  const status = opts.status ?? "scheduled";
  const calledOff = ["cancelled", "completed_after_cancellation"].includes(status) && opts.by !== null && opts.by !== undefined;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, route_id, crew_id,
                              cancelled_by, cancelled_at, cancel_notice_hours)
    values (${ORG}, ${job!.id}, ${status}::visit_status,
            ${day ? local(day, "09:00") : null}, ${day ? local(day, "11:00") : null},
            ${opts.onRoute === false ? null : routeId}, ${opts.onRoute === false ? crewId : null},
            ${calledOff ? opts.by! : null}::visit_cancelled_by,
            ${calledOff ? raw.unsafe(`(('${day} 09:00'::timestamp at time zone '${ZONE}') - interval '${opts.askedHoursBefore ?? 48} hours')`) : null},
            ${calledOff ? opts.notice ?? 24 : null})
    returning id`;
  return visit!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  types.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cancel Cleaning Co", slug: "kpi-cancel-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'cleaning' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Rosa Reyes', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Willow', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [route] = await raw<{ id: string }[]>`
    insert into public.route (organization_id, name, day_of_week) values (${ORG}, 'North', 3) returning id`;
  routeId = route!.id;
  const [crew] = await raw<{ id: string }[]>`
    insert into public.crew (organization_id, name) values (${ORG}, 'Team B') returning id`;
  crewId = crew!.id;
});

/**
 * The month, by hand. Every stop is at nine; the notice window is a day.
 *
 *   S1   done                                                        kept      in the bottom
 *   S2   still to come                                               kept      in the bottom
 *   S3   the customer cancelled two hours before                     late      in both
 *   S4   the customer cancelled thirty hours before                  in time   in the bottom
 *   S5   the company called it off for rain                          left out, counted beside
 *   S6   cancelled with nobody saying who                            left out, counted beside as not known
 *   S7   the customer turned the team away ten minutes in            late      in both
 *   S8   cancelled thirty hours before under a two day window        late      in both
 *   S9   cancelled late, in July                                     another month
 *   S10  cancelled late, on an estimate walkthrough (internal)       not customer work
 *   S11  no time on it yet                                           not a stop
 *   S12  cancelled late and done anyway on a phone that missed it    late      in both
 *
 *   Late: S3, S7, S8, S12 = 4. Scheduled: S1 S2 S3 S4 S7 S8 S12 = 7.   4 / 7 = 57.1%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.S1 = await stop("S1", { status: "completed" });
  ids.S2 = await stop("S2", { day: "2026-06-24" });
  ids.S3 = await stop("S3", { status: "cancelled", by: "customer", askedHoursBefore: 2 });
  ids.S4 = await stop("S4", { status: "cancelled", by: "customer", askedHoursBefore: 30, onRoute: false });
  ids.S5 = await stop("S5", { status: "cancelled", by: "company", askedHoursBefore: 1 });
  ids.S6 = await stop("S6", { status: "cancelled", by: null });
  ids.S7 = await stop("S7", { status: "cancelled", by: "customer", askedHoursBefore: -1 / 6 });
  ids.S8 = await stop("S8", { status: "cancelled", by: "customer", askedHoursBefore: 30, notice: 48 });
  ids.S9 = await stop("S9", { day: "2026-07-01", status: "cancelled", by: "customer", askedHoursBefore: 2 });
  ids.S10 = await stop("S10", { status: "cancelled", by: "customer", askedHoursBefore: 2, revenueClass: "internal" });
  ids.S11 = await stop("S11", { day: null });
  ids.S12 = await stop("S12", { status: "completed_after_cancellation", by: "customer", askedHoursBefore: 3 });
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "cancel_rate_route")!;

run("cancellation rate by route", () => {
  it("counts the customer's late cancellations over the stops scheduled, the company's left out", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["4", "7", "57.1"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "excluded", count: "1" }),
      expect.objectContaining({ key: "unknown", count: "1" }),
    ]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const late = await kpis.drill(owner(), { key: "cancel_rate_route", half: "numerator", ...WINDOW });
    expect(late.records.map((r) => name(r.id)).sort()).toEqual(["S12", "S3", "S7", "S8"]);
    const scheduled = await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW });
    expect(scheduled.records.map((r) => name(r.id)).sort()).toEqual(["S1", "S12", "S2", "S3", "S4", "S7", "S8"]);
    const company = await kpis.drill(owner(), { key: "cancel_rate_route", half: "excluded", ...WINDOW });
    expect(company.records.map((r) => name(r.id))).toEqual(["S5"]);
    const unknown = await kpis.drill(owner(), { key: "cancel_rate_route", half: "unknown", ...WINDOW });
    expect(unknown.records.map((r) => name(r.id))).toEqual(["S6"]);

    /** Per route and per weekday: each record says which. June 10th is a Wednesday. */
    const s3 = late.records.find((r) => r.id === ids.S3)!;
    expect(s3.label).toBe("#3 Rosa Reyes, North, Wednesday");
    expect(s3.href).toBe(`/visits/${ids.S3}`);
    expect(scheduled.records.find((r) => r.id === ids.S4)!.label).toBe("#4 Rosa Reyes, Team B, Wednesday");
  });

  it("puts the same stops through core's rule and gets the same answer", async () => {
    await month();
    const rows = await raw<{
      status: string; window_start: Date | null; cancelled_by: "customer" | "company" | null;
      cancelled_at: Date | null; cancel_notice_hours: number | null; revenue_class: string;
    }[]>`
      select v.status::text, v.window_start, v.cancelled_by::text as cancelled_by, v.cancelled_at, v.cancel_notice_hours,
             jt.revenue_class::text
      from public.visit v join public.job j on j.id = v.job_id join public.job_type jt on jt.id = j.job_type_id
      where v.organization_id = ${ORG}`;
    const counts = { late: 0, scheduled: 0, company: 0, unknown: 0 };
    for (const row of rows) {
      if (row.revenue_class === "internal" || row.window_start === null) continue;
      const day = row.window_start.toLocaleDateString("en-CA", { timeZone: ZONE });
      if (day < WINDOW.from || day > WINDOW.to) continue;
      const verdict = reporting.cancellationOf({
        status: row.status, windowStart: row.window_start, cancelledBy: row.cancelled_by,
        cancelledAt: row.cancelled_at, noticeHours: row.cancel_notice_hours,
      });
      if (verdict === "late") counts.late += 1;
      if (verdict === "late" || verdict === "in_time" || verdict === "kept") counts.scheduled += 1;
      if (verdict === "company") counts.company += 1;
      if (verdict === "unknown") counts.unknown += 1;
    }
    const kpi = await figure();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([counts.late, counts.scheduled]);
    expect(kpi.besides!.map((b) => Number(b.count))).toEqual([counts.company, counts.unknown]);
  });

  it("is not a number in a month with nothing scheduled", async () => {
    const kpi = await figure();
    expect(kpi.value).toBeNull();
  });
});

/* ======================================================== every path that cancels */

/** A visit booked a few days from now, through the jobs service as the office books one. */
async function booked(opts: { days?: number } = {}): Promise<{ jobId: string; visitId: string }> {
  seq += 1;
  const start = new Date(Date.now() + (opts.days ?? 3) * 86_400_000);
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${await typeOf("recurring")}, 'scheduled', 'Clean') returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, created_at)
    values (${ORG}, ${job!.id}, 'scheduled', ${start}, ${new Date(start.getTime() + 7_200_000)}, now() - interval '2 days')
    returning id`;
  return { jobId: job!.id, visitId: visit!.id };
}

const visitRow = async (id: string) => (await raw<{
  status: string; cancelled_by: string | null; cancelled_at: Date | null; cancel_notice_hours: number | null;
}[]>`select status::text, cancelled_by::text as cancelled_by, cancelled_at, cancel_notice_hours from public.visit where id = ${id}`)[0]!;

run("calling off one visit from the office", () => {
  it("says who asked and when, freezes the notice window, and is audited", async () => {
    const { visitId } = await booked();
    const asked = new Date(Date.now() - 3_600_000);
    const done = await cancellations.cancel(owner(), { id: visitId, by: "customer", askedAt: asked.toISOString() });
    expect(done).toMatchObject({ status: "cancelled", cancelledBy: "customer", cancelNoticeHours: 24, late: false });
    expect(done.cancelledAt).toBe(asked.toISOString());

    const row = await visitRow(visitId);
    expect(row).toMatchObject({ status: "cancelled", cancelled_by: "customer", cancel_notice_hours: 24 });
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${visitId} and action = 'visit.called_off'`;
    expect(audited.length).toBe(1);

    /** Changing the policy afterwards does not move it. */
    await cancellations.setNotice(owner(), { hours: 96 });
    expect((await visitRow(visitId)).cancel_notice_hours).toBe(24);
    const page = await visits.get(owner(), { id: visitId });
    expect(page.cancellation).toMatchObject({ by: "customer", noticeHours: 24, late: false });
  });

  it("judges a late one by the window the company set", async () => {
    await cancellations.setNotice(owner(), { hours: 96 });
    const { visitId } = await booked({ days: 2 });
    const done = await cancellations.cancel(owner(), { id: visitId, by: "customer" });
    expect(done).toMatchObject({ cancelNoticeHours: 96, late: true });
    const company = await cancellations.cancel(owner(), { id: (await booked({ days: 1 })).visitId, by: "company" });
    expect(company.late).toBe(false);
  });

  it("gives the first answer back to a retry", async () => {
    const { visitId } = await booked();
    const first = await cancellations.cancel(owner("cancel-once"), { id: visitId, by: "company" });
    const again = await cancellations.cancel(owner("cancel-once"), { id: visitId, by: "company" });
    expect(again).toEqual(first);
  });

  it("refuses a time not yet come, one before the visit was booked, work under way, and somebody who may not reschedule", async () => {
    const { visitId } = await booked();
    await expect(cancellations.cancel(owner(), { id: visitId, by: "customer", askedAt: new Date(Date.now() + 86_400_000).toISOString() }))
      .rejects.toThrow(/not happened yet/);
    await expect(cancellations.cancel(owner(), { id: visitId, by: "customer", askedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }))
      .rejects.toThrow(/before the visit was booked/);
    await expect(cancellations.cancel(as("technician"), { id: visitId, by: "customer" })).rejects.toThrow(/visit:reschedule/);
    await raw`update public.visit set status = 'working' where id = ${visitId}`;
    await expect(cancellations.cancel(owner(), { id: visitId, by: "customer" })).rejects.toBeInstanceOf(ConflictError);
  });
});

run("cancelling a job with its visits", () => {
  it("says who asked for every visit it calls off, and leaves it not known when nobody said", async () => {
    const said = await booked();
    await jobs.update(owner(), { id: said.jobId, status: "cancelled", cancelVisits: true, cancelledBy: "company" });
    expect(await visitRow(said.visitId)).toMatchObject({ status: "cancelled", cancelled_by: "company", cancel_notice_hours: 24 });

    const silent = await booked();
    await jobs.update(owner(), { id: silent.jobId, status: "cancelled", cancelVisits: true });
    expect(await visitRow(silent.visitId)).toMatchObject({ status: "cancelled", cancelled_by: null, cancelled_at: null });

    const stray = await booked();
    await expect(jobs.update(owner(), { id: stray.jobId, status: "cancelled", cancelledBy: "customer" }))
      .rejects.toBeInstanceOf(UnprocessableError);
  });
});

run("a customer's request from their link", () => {
  it("is the customer, asked when they sent it", async () => {
    const { jobId, visitId } = await booked();
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId, scope: "job", subjectId: jobId, expiresInDays: 30,
    }));
    const asked = await visitChanges.request(db(), { token: link.token, kind: "cancel", reason: "Away that week" });
    await raw`update public.visit_change_request set created_at = now() - interval '5 hours' where id = ${asked.id}`;
    await visitChanges.approve(owner(), { id: asked.id });
    const [request] = await raw<{ created_at: Date }[]>`select created_at from public.visit_change_request where id = ${asked.id}`;
    const row = await visitRow(visitId);
    expect(row).toMatchObject({ status: "cancelled", cancelled_by: "customer", cancel_notice_hours: 24 });
    expect(row.cancelled_at!.toISOString()).toBe(request!.created_at.toISOString());
  });
});

run("a visit brought in already cancelled", () => {
  it("keeps who and when as the old system said, or neither", async () => {
    const { jobId } = await booked();
    const base = { id: jobId, status: "cancelled" as const, estimatedDurationMinutes: 60, technicianIds: [] };
    const said = await jobs.addVisit(owner(), { ...base, cancelledBy: "customer", cancelledAt: "2026-05-01T12:00:00Z" });
    expect(await visitRow(said.id)).toMatchObject({ cancelled_by: "customer", cancel_notice_hours: 24 });
    const silent = await jobs.addVisit(owner(), base);
    expect(await visitRow(silent.id)).toMatchObject({ status: "cancelled", cancelled_by: null });
    await expect(jobs.addVisit(owner(), { ...base, cancelledBy: "customer" })).rejects.toBeInstanceOf(UnprocessableError);
  });

  it("is refused by the database when it names who without saying when", async () => {
    const { visitId } = await booked();
    await expect(raw`update public.visit set status = 'cancelled', cancelled_by = 'customer' where id = ${visitId}`)
      .rejects.toThrow(/visit_cancel_says_when/);
  });
});

run("the notice window", () => {
  it("is a day until the company sets it, in whole hours up to a month, by somebody who may change settings", async () => {
    expect(await cancellations.notice(owner())).toEqual({ hours: 24 });
    expect(await cancellations.setNotice(owner(), { hours: 48 })).toEqual({ hours: 48 });
    expect(await cancellations.notice(owner())).toEqual({ hours: 48 });
    await expect(cancellations.setNotice(owner(), { hours: 721 })).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellations.setNotice(as("technician"), { hours: 12 })).rejects.toThrow(/settings:write/);
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'organization.cancel_notice_set'`;
    expect(audited.length).toBe(1);
  });
});
