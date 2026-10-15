import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import * as jobHolds from "../src/services/job-holds";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * FIRST TIME FIX, AND THE HOLD THAT SAYS WHY A JOB WAITED
 *
 * The first time fix rate needed two data it did not have: a job that says it
 * was PLANNED as several visits, and a hold that says it was waiting on a part
 * order (or, for an electrician, an inspection). Both are recorded now, and
 * this file checks the figure against a month worked out by hand under each of
 * the three trades that declare it, puts the same jobs through core's rule and
 * requires the same answer, and then checks how a hold is placed and lifted.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-ftf:org");
const USER = fixtureId("kpi-ftf:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (idempotencyKey?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let vendorId = "";
let locationId = "";
let seq = 0;
const types = new Map<string, string>();

async function trade(id: string): Promise<void> {
  await raw`update public.organization set primary_trade = ${id} where id = ${ORG}`;
}

async function typeOf(revenueClass: string): Promise<string> {
  const found = types.get(revenueClass);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, ${revenueClass}, ${`ftf-${revenueClass}`}, ${revenueClass}::job_revenue_class) returning id`;
  types.set(revenueClass, row!.id);
  return row!.id;
}

/** A local wall clock time in Austin, as an instant. */
const local = (day: string, time = "10:00") => `('${day} ${time}'::timestamp at time zone '${ZONE}')`;

/**
 * A job finished on `done`, with visits each done on a day (or not done:
 * `cancelled`), planned as several visits at a moment if `plannedAt` is given.
 */
async function job(name: string, opts: {
  revenueClass?: string; done?: string | null; status?: string;
  visits?: Array<{ day: string; status?: string }>;
  plannedAt?: string;
}): Promise<string> {
  seq += 1;
  const done = opts.done === undefined ? "2026-06-20" : opts.done;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at,
                            multi_visit_planned_at)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${await typeOf(opts.revenueClass ?? "service")},
            ${opts.status ?? (done ? "completed" : "scheduled")}::job_status, ${name},
            ${done ? raw.unsafe(local(done, "16:00")) : null},
            ${opts.plannedAt ? raw.unsafe(local(opts.plannedAt.split(" ")[0]!, opts.plannedAt.split(" ")[1])) : null})
    returning id`;
  let n = 0;
  for (const visit of opts.visits ?? []) {
    n += 1;
    const status = visit.status ?? "completed";
    const happened = status === "completed" || status === "completed_after_cancellation";
    await raw`
      insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end, arrived_at, completed_at)
      values (${ORG}, ${row!.id}, ${n}, ${status}::visit_status,
              ${raw.unsafe(local(visit.day, "08:00"))}, ${raw.unsafe(local(visit.day, "12:00"))},
              ${happened ? raw.unsafe(local(visit.day, "09:00")) : null},
              ${happened ? raw.unsafe(local(visit.day, "11:00")) : null})`;
  }
  return row!.id;
}

async function order(status: string): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.purchase_order (organization_id, number, vendor_id, default_location_id, status, submitted_at)
    values (${ORG}, ${seq}, ${vendorId}, ${locationId}, ${status}::purchase_order_status,
            ${status === "draft" ? null : raw.unsafe("now()")})
    returning id`;
  return row!.id;
}

/** A hold, written as the record it is, placed at a local time. */
async function held(jobId: string, reason: string, on: string, purchaseOrderId: string | null = null): Promise<void> {
  await raw`
    insert into public.job_hold (organization_id, job_id, reason, purchase_order_id, note, status_before, placed_at, released_at)
    values (${ORG}, ${jobId}, ${reason}::job_hold_reason, ${purchaseOrderId}, 'Fixture', 'in_progress',
            ${raw.unsafe(local(on, "13:00"))}, ${raw.unsafe(local(on, "14:00"))})`;
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "First Fix Co", slug: "kpi-first-fix-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Oak', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [vendor] = await raw<{ id: string }[]>`
    insert into public.vendor (organization_id, name) values (${ORG}, 'Supply House') returning id`;
  vendorId = vendor!.id;
  const [location] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Shop') returning id`;
  locationId = location!.id;
});

/**
 * The month, by hand. Every job is finished on June 20th unless it says
 * otherwise; a part order "sent" went to the supplier and a "draft" did not.
 *
 *   J1   one visit done                                          fixed
 *   J2   two visits done                                         returned
 *   J3   install planned on June 1st, three visits               planned: out everywhere
 *   J4   planned at 10:00 on the 10th, after arriving at 09:00   returned (a late plan is not a plan)
 *   J5   held for a part on a sent order, two visits             out for plumbing and electrical
 *   J6   held for a part on a draft order, two visits            returned (nothing was ordered)
 *   J7   held for an inspection, two visits                      out for electrical only
 *   J8   a cancelled visit and one done                          fixed
 *   J9   finished from the office, no visit done                 unknown: out everywhere, not counted beside
 *   J10  internal work, one visit                                 not customer work
 *   J11  one visit, finished on July 2nd                          another month
 *   J12  one visit done, one done after it was cancelled         returned
 *   J13  held for a part after it was finished                   returned (the hold came too late)
 *
 *   Plumbing    fixed J1 J8 = 2; counted J1 J2 J4 J6 J7 J8 J12 J13 = 8; left out J3 J5 = 2.   2/8 = 25.0%
 *   HVAC        fixed 2; counted also J5 = 9; left out J3 = 1.                               2/9 = 22.2%
 *   Electrical  fixed 2; counted J1 J2 J4 J6 J8 J12 J13 = 7; left out J3 J5 J7 = 3.         2/7 = 28.6%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.J1 = await job("J1", { visits: [{ day: "2026-06-10" }] });
  ids.J2 = await job("J2", { visits: [{ day: "2026-06-10" }, { day: "2026-06-12" }] });
  ids.J3 = await job("J3", {
    revenueClass: "install", plannedAt: "2026-06-01 09:00",
    visits: [{ day: "2026-06-10" }, { day: "2026-06-11" }, { day: "2026-06-12" }],
  });
  ids.J4 = await job("J4", { plannedAt: "2026-06-10 10:00", visits: [{ day: "2026-06-10" }, { day: "2026-06-12" }] });
  ids.J5 = await job("J5", { visits: [{ day: "2026-06-10" }, { day: "2026-06-15" }] });
  await held(ids.J5, "part", "2026-06-10", await order("submitted"));
  ids.J6 = await job("J6", { visits: [{ day: "2026-06-10" }, { day: "2026-06-15" }] });
  await held(ids.J6, "part", "2026-06-10", await order("draft"));
  ids.J7 = await job("J7", { visits: [{ day: "2026-06-10" }, { day: "2026-06-15" }] });
  await held(ids.J7, "inspection", "2026-06-10");
  ids.J8 = await job("J8", { visits: [{ day: "2026-06-09", status: "cancelled" }, { day: "2026-06-10" }] });
  ids.J9 = await job("J9", { visits: [] });
  ids.J10 = await job("J10", { revenueClass: "internal", visits: [{ day: "2026-06-10" }] });
  ids.J11 = await job("J11", { done: "2026-07-02", visits: [{ day: "2026-07-02" }] });
  ids.J12 = await job("J12", { visits: [{ day: "2026-06-10" }, { day: "2026-06-11", status: "completed_after_cancellation" }] });
  ids.J13 = await job("J13", { visits: [{ day: "2026-06-10" }, { day: "2026-06-15" }] });
  await held(ids.J13, "part", "2026-06-25", await order("submitted"));
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "first_time_fix")!;

run("first time fix rate", () => {
  it("leaves out planned work and, by trade, the jobs held for a part order or an inspection", async () => {
    const ids = await month();
    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)![0];
    const listed = async (half: "numerator" | "denominator" | "excluded") =>
      (await kpis.drill(owner(), { key: "first_time_fix", half, ...WINDOW })).records.map((r) => name(r.id)).sort();

    await trade("plumbing");
    let kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["2", "8", "25.0"]);
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "excluded", count: "2" })]);
    expect(await listed("numerator")).toEqual(["J1", "J8"]);
    expect(await listed("denominator")).toEqual(["J1", "J12", "J13", "J2", "J4", "J6", "J7", "J8"]);
    expect(await listed("excluded")).toEqual(["J3", "J5"]);

    await trade("hvac");
    kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["2", "9", "22.2"]);
    expect(await listed("excluded")).toEqual(["J3"]);

    await trade("electrical");
    kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["2", "7", "28.6"]);
    expect(await listed("excluded")).toEqual(["J3", "J5", "J7"]);
  });

  it("puts the same jobs through core's rule and gets the same answer", async () => {
    await month();
    const rows = await raw<{
      id: string; completed_at: Date; planned: Date | null; revenue_class: string;
    }[]>`
      select j.id, j.completed_at, j.multi_visit_planned_at as planned, jt.revenue_class::text
      from public.job j join public.job_type jt on jt.id = j.job_type_id
      where j.organization_id = ${ORG} and j.completed_at is not null`;
    const visits = await raw<{ job_id: string; status: string; arrived_at: Date | null; completed_at: Date | null }[]>`
      select job_id, status::text, arrived_at, completed_at from public.visit where organization_id = ${ORG}`;
    const holds = await raw<{ job_id: string; reason: string; placed_at: Date; order_status: string | null }[]>`
      select h.job_id, h.reason::text, h.placed_at, po.status::text as order_status
      from public.job_hold h left join public.purchase_order po on po.id = h.purchase_order_id
      where h.organization_id = ${ORG}`;

    for (const tradeId of ["plumbing", "hvac", "electrical"]) {
      const verdicts = new Map<string, string>();
      for (const row of rows) {
        if (row.revenue_class === "internal") continue;
        const finishedOn = row.completed_at.toLocaleDateString("en-CA", { timeZone: ZONE });
        if (finishedOn < WINDOW.from || finishedOn > WINDOW.to) continue;
        verdicts.set(row.id, reporting.firstTimeFixOf({
          completedAt: row.completed_at,
          multiVisitPlannedAt: row.planned,
          visits: visits.filter((v) => v.job_id === row.id)
            .map((v) => ({ status: v.status, arrivedAt: v.arrived_at, completedAt: v.completed_at })),
          holds: holds.filter((h) => h.job_id === row.id).map((h) => ({
            reason: h.reason, placedAt: h.placed_at,
            orderPlaced: h.order_status !== null && !["draft", "cancelled"].includes(h.order_status),
          })),
        }, tradeId));
      }
      await trade(tradeId);
      const ids = async (half: "numerator" | "denominator" | "excluded") =>
        (await kpis.drill(owner(), { key: "first_time_fix", half, ...WINDOW })).records.map((r) => r.id).sort();
      const pick = (...verdict: string[]) => [...verdicts].filter(([, v]) => verdict.includes(v)).map(([id]) => id).sort();
      expect(await ids("numerator"), tradeId).toEqual(pick("fixed"));
      expect(await ids("denominator"), tradeId).toEqual(pick("fixed", "returned"));
      expect(await ids("excluded"), tradeId).toEqual(pick("excluded"));
    }
  });

  it("is nothing rather than nought in a month with no completed job", async () => {
    await trade("plumbing");
    const kpi = await figure();
    expect(kpi.value).toBeNull();
    expect(kpi.denominator).toBe("0");
  });
});

/* ===================================================== planning and holds */

/** A booked job with one visit still to come, through the service. */
async function booked(): Promise<{ jobId: string; visitId: string }> {
  const created = await jobs.create(owner(), {
    customerId, propertyId, jobTypeId: await typeOf("service"), summary: "No hot water", tags: [], customFields: {},
    visit: {
      windowStart: "2030-01-10T15:00:00Z", windowEnd: "2030-01-10T19:00:00Z",
      estimatedDurationMinutes: 60, technicianIds: [],
    },
  });
  return { jobId: created.id, visitId: created.visits[0]!.id };
}

run("planning a job as more than one visit", () => {
  it("is recorded when the job is booked, and can be said later until somebody arrives", async () => {
    const created = await jobs.create(owner(), {
      customerId, propertyId, summary: "Two day install", tags: [], customFields: {}, multiVisitPlanned: true,
    });
    expect(created.multiVisitPlannedAt).not.toBeNull();

    const { jobId, visitId } = await booked();
    const planned = await jobs.update(owner(), { id: jobId, multiVisitPlanned: true });
    expect(planned.multiVisitPlannedAt).not.toBeNull();
    const unplanned = await jobs.update(owner(), { id: jobId, multiVisitPlanned: false });
    expect(unplanned.multiVisitPlannedAt).toBeNull();

    await raw`update public.visit set arrived_at = now(), status = 'working' where id = ${visitId}`;
    const late = await jobs.update(owner(), { id: jobId, multiVisitPlanned: true }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(ConflictError);
    expect((late as Error).message).toMatch(/already started/);
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${jobId} and action = 'job.updated'`;
    expect(audited.length).toBeGreaterThan(0);
  });
});

run("a hold says why a job is waiting", () => {
  it("puts a job on hold for a part on an order, and takes it off back where it was", async () => {
    const { jobId } = await booked();
    const po = await order("submitted");
    const placed = await jobHolds.place(owner(), { id: jobId, reason: "part", purchaseOrderId: po, note: "Gas valve" });
    expect(placed.data).toEqual([expect.objectContaining({
      reason: "part", reasonLabel: "Waiting on a part", purchaseOrderId: po, statusBefore: "scheduled", releasedAt: null,
    })]);
    const [onHold] = await raw<{ status: string }[]>`select status::text from public.job where id = ${jobId}`;
    expect(onHold!.status).toBe("on_hold");
    expect((await jobHolds.waitingOn(owner(), { purchaseOrderId: po })).map((r) => r.jobId)).toEqual([jobId]);

    const released = await jobHolds.release(owner(), { id: placed.data[0]!.id });
    expect(released.data[0]!.releasedAt).not.toBeNull();
    const [back] = await raw<{ status: string }[]>`select status::text from public.job where id = ${jobId}`;
    expect(back!.status).toBe("scheduled");
    const events = await raw<{ name: string }[]>`
      select name from public.domain_event where organization_id = ${ORG} and entity_id = ${jobId} order by sequence`;
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(["job.on_hold", "job.scheduled"]));
  });

  it("refuses a part with no order, a cancelled order, and a second reason over the first", async () => {
    const { jobId } = await booked();
    await expect(jobHolds.place(owner(), { id: jobId, reason: "part" })).rejects.toThrow(/purchase order/);
    await expect(jobHolds.place(owner(), { id: jobId, reason: "part", purchaseOrderId: await order("cancelled") }))
      .rejects.toThrow(/cancelled/);
    await expect(jobHolds.place(owner(), { id: jobId, reason: "inspection" })).rejects.toThrow(/which inspection/);
    await jobHolds.place(owner(), { id: jobId, reason: "customer" });
    await expect(jobHolds.place(owner(), { id: jobId, reason: "weather" })).rejects.toThrow(/already on hold: waiting on the customer/);
  });

  it("refuses a job that is finished, and one the reader cannot see", async () => {
    const finished = await job("Done", { visits: [{ day: "2026-06-10" }] });
    await expect(jobHolds.place(owner(), { id: finished, reason: "customer" })).rejects.toThrow(/cannot go on hold/);
    await expect(jobHolds.place(owner(), { id: "00000000-0000-4000-8000-000000000000", reason: "customer" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("needs a person who may change the job, and naming an order needs purchasing", async () => {
    const { jobId } = await booked();
    await expect(jobHolds.place(as("technician"), { id: jobId, reason: "customer" })).rejects.toThrow(/job:write/);
    /** A dispatcher changes jobs and does not read purchase orders. */
    await expect(jobHolds.place(as("dispatcher"), { id: jobId, reason: "part", purchaseOrderId: await order("submitted") }))
      .rejects.toThrow(/po:read/);
    const placed = await jobHolds.place(as("dispatcher"), { id: jobId, reason: "weather" });
    expect(placed.data[0]!.reason).toBe("weather");
  });

  it("closes the hold when the job is moved off hold some other way", async () => {
    const { jobId } = await booked();
    await jobHolds.place(owner(), { id: jobId, reason: "customer" });
    await jobs.update(owner(), { id: jobId, status: "cancelled" });
    const holds = await jobHolds.holdsOf(owner(), { id: jobId });
    expect(holds.data[0]!.releasedAt).not.toBeNull();
  });

  it("gives a job put on hold before reasons existed a reason, and sends it back to booked", async () => {
    const { jobId } = await booked();
    await jobs.update(owner(), { id: jobId, status: "on_hold" });
    const placed = await jobHolds.place(owner(), { id: jobId, reason: "inspection", note: "City final" });
    expect(placed.data[0]!.statusBefore).toBe("scheduled");
    await jobHolds.release(owner(), { id: placed.data[0]!.id });
    const [back] = await raw<{ status: string }[]>`select status::text from public.job where id = ${jobId}`;
    expect(back!.status).toBe("scheduled");
  });

  it("answers a replayed request with the first answer and places one hold", async () => {
    const { jobId } = await booked();
    const first = await jobHolds.place(owner("ftf-hold-1"), { id: jobId, reason: "customer" });
    const again = await jobHolds.place(owner("ftf-hold-1"), { id: jobId, reason: "customer" });
    expect(again).toEqual(first);
    const rows = await raw`select 1 from public.job_hold where job_id = ${jobId}`;
    expect(rows.length).toBe(1);
  });
});
