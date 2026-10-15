import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import * as changeOrders from "../src/services/project-change-orders";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * BUDGETED HOUR VARIANCE, AND THE TWO NUMBERS IT WAITED ON
 *
 * Lawn and landscape's "actual crew hours minus budgeted hours on completed
 * jobs, as a percentage of budgeted", less the hours of change orders the
 * customer separately approved. A job now carries the crew hours it was
 * budgeted, fixed once the first hour is punched, and a change order carries
 * the crew hours it adds and the job they are worked on. A month worked out by
 * hand, the same jobs through core's rule, and how both numbers are recorded.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-budget:org");
const USER = fixtureId("kpi-budget:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let projectId = "";
let techId = "";
let seq = 0;
const types = new Map<string, string>();

async function typeOf(revenueClass: string): Promise<string> {
  const found = types.get(revenueClass);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, ${revenueClass}, ${`bh-${revenueClass}`}, 'crew_production', ${revenueClass}::job_revenue_class) returning id`;
  types.set(revenueClass, row!.id);
  return row!.id;
}

const local = (day: string, time: string) => raw.unsafe(`('${day} ${time}'::timestamp at time zone '${ZONE}')`);

/** A job finished on `done`, budgeted `budget` crew hours, in the project. */
async function job(name: string, opts: { budget?: string | null; done?: string; revenueClass?: string } = {}): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at, budgeted_hours)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${await typeOf(opts.revenueClass ?? "project")}, 'completed', ${name},
            ${local(opts.done ?? "2026-06-20", "16:00")}, ${opts.budget === undefined ? null : opts.budget})
    returning id`;
  await raw`insert into public.project_job (organization_id, project_id, job_id) values (${ORG}, ${projectId}, ${row!.id})`;
  return row!.id;
}

/** A punch on the job, of so many minutes, by somebody on the crew. */
async function punch(jobId: string, minutes: number, kind = "on_site", ended = true): Promise<void> {
  await raw`
    insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes)
    values (${ORG}, ${techId}, ${jobId}, ${kind}::time_entry_kind, ${local("2026-06-15", "08:00")},
            ${ended ? raw.unsafe(`(('2026-06-15 08:00'::timestamp at time zone '${ZONE}') + interval '${minutes} minutes')`) : null},
            ${ended ? minutes : null})`;
}

async function changeOrder(jobId: string, hours: string, status: string): Promise<void> {
  seq += 1;
  await raw`
    insert into public.project_change_order (organization_id, project_id, number, title, status, crew_hours, job_id)
    values (${ORG}, ${projectId}, ${seq}, 'Extra beds', ${status}::project_change_order_status, ${hours}, ${jobId})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@kpi-budget.test'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  types.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Budget Co", slug: "kpi-budget-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'lawn-and-landscape' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '3 Elm', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [project] = await raw<{ id: string }[]>`
    insert into public.project (organization_id, customer_id, property_id, name, status)
    values (${ORG}, ${customerId}, ${propertyId}, 'Back garden', 'active') returning id`;
  projectId = project!.id;
  const [person] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`crew-${Date.now()}@kpi-budget.test`}, 'Crew') returning id`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${person!.id}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${membership!.id}, 'Crew', true) returning id`;
  techId = tech!.id;
});

/**
 * The month, by hand.
 *
 *   B1  budget 10: three people four hours on site and forty minutes driving   14 h   over  4
 *   B2  budget 20: 22 hours, a 3 hour change order approved                     19 h   over -1
 *   B3  budget  8: 6 hours, a 2 hour change order sent and not yet approved      6 h   over -2
 *   B4  budget  5: a punch still running                                         left out
 *   B5  no budget, 6 hours                                                       left out
 *   B6  budget  4, nobody punched                                                left out
 *   B7  budget  6: 8 hours on site, an unpaid hour's break not counted            8 h   over  2
 *   B8  budget 10, finished in July                                              another month
 *   B9  internal work budgeted 3, 5 hours                                        not customer work
 *
 *   Over 4 - 1 - 2 + 2 = 3 hours; budgeted 10 + 20 + 8 + 6 = 44.   3 / 44 = 6.8%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.B1 = await job("B1", { budget: "10" });
  for (let i = 0; i < 3; i += 1) { await punch(ids.B1, 240); await punch(ids.B1, 40, "travel"); }
  ids.B2 = await job("B2", { budget: "20" });
  await punch(ids.B2, 1200); await punch(ids.B2, 120);
  await changeOrder(ids.B2, "3", "approved");
  ids.B3 = await job("B3", { budget: "8" });
  await punch(ids.B3, 360);
  await changeOrder(ids.B3, "2", "sent");
  ids.B4 = await job("B4", { budget: "5" });
  await punch(ids.B4, 120); await punch(ids.B4, 0, "on_site", false);
  ids.B5 = await job("B5");
  await punch(ids.B5, 360);
  ids.B6 = await job("B6", { budget: "4" });
  ids.B7 = await job("B7", { budget: "6" });
  await punch(ids.B7, 480); await punch(ids.B7, 60, "unpaid_break");
  ids.B8 = await job("B8", { budget: "10", done: "2026-07-02" });
  await punch(ids.B8, 600);
  ids.B9 = await job("B9", { budget: "3", revenueClass: "internal" });
  await punch(ids.B9, 300);
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "budget_hour_variance")!;

run("budgeted hour variance", () => {
  it("takes approved change order hours off the actual, and leaves out jobs whose hours are not all in", async () => {
    const ids = await month();
    const kpi = await figure();
    expect(Number(kpi.numerator)).toBeCloseTo(3, 6);
    expect(Number(kpi.denominator)).toBeCloseTo(44, 6);
    expect(kpi.value).toBe("6.8");

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)![0];
    const over = await kpis.drill(owner(), { key: "budget_hour_variance", half: "numerator", ...WINDOW });
    expect(Object.fromEntries(over.records.map((r) => [name(r.id), Number(r.value)])))
      .toEqual({ B1: 4, B2: -1, B3: -2, B7: 2 });
    const budgeted = await kpis.drill(owner(), { key: "budget_hour_variance", half: "denominator", ...WINDOW });
    expect(budgeted.records.map((r) => name(r.id)).sort()).toEqual(["B1", "B2", "B3", "B7"]);
    expect(Number(budgeted.total)).toBeCloseTo(44, 6);
  });

  it("puts the same jobs through core's rule and gets the same answer", async () => {
    await month();
    const rows = await raw<{ id: string; budgeted_hours: string | null; completed_at: Date; revenue_class: string }[]>`
      select j.id, j.budgeted_hours, j.completed_at, jt.revenue_class::text
      from public.job j join public.job_type jt on jt.id = j.job_type_id where j.organization_id = ${ORG}`;
    const punches = await raw<{ job_id: string; kind: string; minutes: number | null; ended_at: Date | null }[]>`
      select job_id, kind::text, minutes, ended_at from public.timeclock_entry where organization_id = ${ORG}`;
    const orders = await raw<{ job_id: string; crew_hours: string; status: string }[]>`
      select job_id, crew_hours, status::text from public.project_change_order where organization_id = ${ORG}`;
    let over = 0;
    let budget = 0;
    const counted: string[] = [];
    for (const row of rows) {
      if (row.revenue_class === "internal") continue;
      const day = row.completed_at.toLocaleDateString("en-CA", { timeZone: ZONE });
      if (day < WINDOW.from || day > WINDOW.to) continue;
      const verdict = reporting.budgetVarianceOf({
        budgetedHours: row.budgeted_hours === null ? null : Number(row.budgeted_hours),
        punches: punches.filter((p) => p.job_id === row.id).map((p) => ({ kind: p.kind, minutes: p.minutes, ended: p.ended_at !== null })),
        approvedChangeHours: orders.filter((o) => o.job_id === row.id && o.status === "approved")
          .reduce((sum, o) => sum + Number(o.crew_hours), 0),
      });
      if (!verdict.counted) continue;
      counted.push(row.id);
      over += verdict.overHours;
      budget += verdict.budgetedHours;
    }
    const kpi = await figure();
    expect(Number(kpi.numerator)).toBeCloseTo(over, 6);
    expect(Number(kpi.denominator)).toBeCloseTo(budget, 6);
    const drilled = await kpis.drill(owner(), { key: "budget_hour_variance", half: "denominator", ...WINDOW });
    expect(drilled.records.map((r) => r.id).sort()).toEqual(counted.sort());
  });

  it("is nothing rather than nought with no budgeted job finished", async () => {
    expect((await figure()).value).toBeNull();
  });
});

run("recording the hours a job was budgeted", () => {
  it("is set when booked, changed before any hour is punched, and fixed after", async () => {
    const created = await jobs.create(owner(), {
      customerId, propertyId, jobTypeId: await typeOf("project"), summary: "Patio", tags: [], customFields: {},
      budgetedHours: "32",
    });
    expect(created.budgetedHours).toBe("32.0000");
    const changed = await jobs.update(owner(), { id: created.id, budgetedHours: "36.5" });
    expect(changed.budgetedHours).toBe("36.5000");
    await expect(jobs.update(owner(), { id: created.id, budgetedHours: "0" })).rejects.toThrow(/A budget is a number of hours/);

    await punch(created.id, 60);
    const refused = await jobs.update(owner(), { id: created.id, budgetedHours: "40" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as Error).message).toMatch(/put the hours on a change order/);
    /** Sending the same budget again is not a change, and is not refused. */
    await expect(jobs.update(owner(), { id: created.id, budgetedHours: "36.5" })).resolves.toBeTruthy();
    await expect(jobs.update(as("technician"), { id: created.id, budgetedHours: "36.5" })).rejects.toThrow(/job:write/);
  });
});

run("crew hours on a change order", () => {
  it("names one of the project's jobs, both or neither, and only while it can be edited", async () => {
    const onProject = await job("On the project", { budget: "10" });
    const [elsewhere] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 900, ${customerId}, ${propertyId}, 'scheduled', 'Elsewhere') returning id`;

    const made = await changeOrders.request(owner(), {
      projectId, title: "Two more beds", crewHours: "6", jobId: onProject,
    });
    expect([made.crewHours, made.jobId]).toEqual(["6.0000", onProject]);

    await expect(changeOrders.request(owner(), { projectId, title: "Hours alone", crewHours: "2" }))
      .rejects.toThrow(/Give both, or neither/);
    await expect(changeOrders.request(owner(), { projectId, title: "Wrong job", crewHours: "2", jobId: elsewhere!.id }))
      .rejects.toThrow(/not part of this project/);

    const moved = await changeOrders.update(owner(), { id: made.id, crewHours: "8" });
    expect(moved.crewHours).toBe("8.0000");
    const cleared = await changeOrders.update(owner(), { id: made.id, crewHours: null, jobId: null });
    expect([cleared.crewHours, cleared.jobId]).toEqual([null, null]);

    await raw`update public.project_change_order set status = 'sent' where id = ${made.id}`;
    await expect(changeOrders.update(owner(), { id: made.id, crewHours: "8", jobId: onProject }))
      .rejects.toThrow(/cannot be changed/);
  });
});
