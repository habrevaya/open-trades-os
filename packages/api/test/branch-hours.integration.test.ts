import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { money as m, time, type Actor, type Permission } from "@opentradesos/core";
import * as businessHours from "../src/services/business-hours";
import * as booking from "../src/services/booking";
import * as afterHours from "../src/services/after-hours";
import * as priceBook from "../src/services/pricebook";
import * as plugins from "../src/services/plugins";
import * as apps from "../src/services/apps";
import * as crews from "../src/services/crews";
import * as taskRules from "../src/services/task-rules";
import * as dispatchDays from "../src/services/dispatch-days";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M02. A BRANCH KEEPS ITS OWN WEEK
 *
 * Branch Hours Co opens Monday to Friday, eight to five, and is shut at the
 * weekend. Its Houston branch keeps a week of its own: Tuesday to Saturday,
 * seven until noon, and shut on Mondays. Austin keeps the company's. Every
 * reader that knows a branch reads Houston's week for Houston's work and the
 * company's for Austin's: the booking page, a booking request checked again,
 * the after hours offer, a pricing rule on work outside the hours, the crew
 * check, task escalation counting working hours, and the multi day
 * rebalance. The Austin manager sets Austin's week and nobody else's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("branch-hours:org");
const USER = fixtureId("branch-hours:user");
const SLUG = "branch-hours-co";
const ZONE = "America/Chicago";

/** The first Friday at least three days out, so nothing here is today or in its past. */
const FRI = (() => {
  for (let offset = 3; ; offset += 1) {
    const day = companyToday(offset, ZONE);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 5) return day;
  }
})();
const SAT = time.addDays(FRI, 1);
const MON = time.addDays(FRI, 3);
const at = (date: string, hour: number) => time.instantOfLocal(date, hour * 60, ZONE);

const COMPANY_WEEK = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
  const open = dayOfWeek >= 1 && dayOfWeek <= 5;
  return { dayOfWeek, opensAt: open ? "08:00" : null, closesAt: open ? "17:00" : null, closed: !open };
});
const HOUSTON_WEEK = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
  const open = dayOfWeek >= 2 && dayOfWeek <= 6;
  return { dayOfWeek, opensAt: open ? "07:00" : null, closesAt: open ? "12:00" : null, closed: !open };
});

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
let austin = "";
let houston = "";
const manager = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["branch_manager"] as Actor["roles"], businessUnitId: austin }, db: db(),
});

let austinService = "";
let houstonService = "";
let morning = "";
let customerId = "";
let propertyId = "";

async function slots(serviceId: string, date: string) {
  const [service] = await inTenant(owner(), (tx) =>
    tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
  return booking.openSlots(db(), { organizationId: ORG, timezone: ZONE, service: service!, from: date, days: 1 });
}

/** A job in a branch with one visit on a date, nine to eleven, unless told to leave the visit off. */
async function jobIn(branchId: string, date: string | null) {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'No cooling', ${branchId}) returning id`;
  if (date) {
    await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'scheduled', ${at(date, 9)}, ${at(date, 11)}, 60)`;
  }
  return job!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Branch Hours Co", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [w] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week, sort_order)
    values (${ORG}, 'Morning', '08:00', '11:00', ${[0, 1, 2, 3, 4, 5, 6]}, 1) returning id`;
  morning = w!.id;
  const [a] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  austin = a!.id;
  houston = h!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, default_duration_minutes)
    values (${ORG}, 'Service call', 60) returning id`;
  const service = async (branchId: string) => (await raw<{ id: string }[]>`insert into public.bookable_service
      (organization_id, job_type_id, public_name, max_per_window, min_notice_hours, max_advance_days, business_unit_id)
    values (${ORG}, ${t!.id}, 'Service call', 5, 24, 60, ${branchId}) returning id`)[0]!.id;
  austinService = await service(austin);
  houstonService = await service(houston);
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Warm') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, '1 Heat Ln', 'Houston', 'TX', '77001', '30.3000000', '-97.7000000', 'rooftop', 'test') returning id`;
  propertyId = p!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["task_escalation", "task", "task_escalation_rule", "time_off", "visit", "job", "business_hours"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  await businessHours.setWeek(owner(), { days: COMPANY_WEEK });
  await businessHours.setWeek(owner(), { days: HOUSTON_WEEK, businessUnitId: houston });
});

run("keeping a branch's own week", () => {
  it("keeps the company's week and Houston's side by side, and setting one leaves the other", async () => {
    const view = await businessHours.list(owner());
    expect(view.company.filter((d) => !d.closed).map((d) => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(view.branches.map((b) => [b.name, b.source])).toEqual([["Austin", "company"], ["Houston", "branch"]]);
    expect(view.branches[1]!.days[6]).toEqual({ dayOfWeek: 6, opensAt: "07:00", closesAt: "12:00", closed: false });
    /** Austin is shown the week it keeps, which is the company's. */
    expect(view.branches[0]!.days).toEqual(view.company);

    await businessHours.setWeek(owner(), { days: COMPANY_WEEK.map((d) => d.dayOfWeek === 5 ? { ...d, closesAt: "15:00" } : d) });
    const after = await businessHours.list(owner());
    expect(after.company[5]!.closesAt).toBe("15:00");
    expect(after.branches[1]!.days).toEqual(view.branches[1]!.days);
  });

  it("puts a branch back on the company's week, and asking twice removes nothing more", async () => {
    expect(await businessHours.followCompany(owner(), { businessUnitId: houston })).toEqual({ businessUnitId: houston, removed: 7 });
    expect((await businessHours.list(owner())).branches[1]!.source).toBe("company");
    expect(await businessHours.followCompany(owner(), { businessUnitId: houston })).toEqual({ businessUnitId: houston, removed: 0 });
  });

  it("refuses half a week, and a day that closes before it opens", async () => {
    await expect(businessHours.setWeek(owner(), { days: HOUSTON_WEEK.slice(0, 6), businessUnitId: houston }))
      .rejects.toThrow(/Send all seven days/);
    await expect(businessHours.setWeek(owner(), {
      days: HOUSTON_WEEK.map((d) => d.dayOfWeek === 2 ? { ...d, opensAt: "13:00", closesAt: "12:00" } : d), businessUnitId: houston,
    })).rejects.toThrow(/closes at 12:00 and opens at 13:00/);
  });

  it("lets the Austin manager set Austin's week and nobody else's, and shows them only Austin's", async () => {
    await expect(businessHours.setWeek(manager(), { days: COMPANY_WEEK }))
      .rejects.toThrow(/You set your own branch's hours/);
    await expect(businessHours.setWeek(manager(), { days: COMPANY_WEEK, businessUnitId: houston }))
      .rejects.toThrow(/You set your own branch's hours/);
    await expect(businessHours.followCompany(manager(), { businessUnitId: houston })).rejects.toThrow(/Branch/);
    await businessHours.setWeek(manager(), { days: COMPANY_WEEK.map((d) => d.dayOfWeek === 6 ? HOUSTON_WEEK[6]! : d), businessUnitId: austin });
    const seen = await businessHours.list(manager());
    expect(seen.branches.map((b) => [b.name, b.source])).toEqual([["Austin", "branch"]]);
    /** The old door to the company's week refuses them too. */
    await expect(booking.setHours(manager(), { days: COMPANY_WEEK })).rejects.toThrow(/You set your own branch's hours/);
  });

  it("refuses a retired branch", async () => {
    const [gone] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name, active) values (${ORG}, 'Waco', false) returning id`;
    await expect(businessHours.setWeek(owner(), { days: HOUSTON_WEEK, businessUnitId: gone!.id })).rejects.toThrow(/retired/);
    await raw`delete from public.business_unit where id = ${gone!.id}`;
  });
});

run("every reader that knows the branch", () => {
  it("offers Houston's Saturday on Houston's booking page and not Austin's, and no Houston Monday", async () => {
    expect(await slots(houstonService, SAT)).toHaveLength(1);
    expect(await slots(austinService, SAT)).toEqual([]);
    expect(await slots(houstonService, MON)).toEqual([]);
    expect(await slots(austinService, MON)).toHaveLength(1);
  });

  it("refuses a booking request on a day the branch has since closed", async () => {
    await expect(booking.createRequest(db(), {
      organizationSlug: SLUG, bookableServiceId: houstonService, requestedDate: MON, arrivalWindowId: morning,
      contactName: "Pat Warm", contactPhone: "+15125550100", addressLine1: "1 Heat Ln", city: "Houston", state: "TX",
      postalCode: "77001", intakeAnswers: {}, utm: {},
    })).rejects.toThrow(/We are closed on/);
    expect(await raw`select 1 from public.booking_request where organization_id = ${ORG}`).toHaveLength(0);
  });

  it("offers the after hours rate on an Austin job booked Saturday morning and not on a Houston one", async () => {
    const item = (await priceBook.create(owner(), { kind: "fee", code: "AFTER", name: "After hours call-out", price: "150.00", taxable: false })).id;
    await afterHours.setRates(owner(), { afterHoursItemId: item, holidayItemId: null });
    try {
      const inAustin = await afterHours.offersForJob(owner(), { jobId: await jobIn(austin, SAT) });
      expect(inAustin).toEqual([expect.objectContaining({ kind: "after_hours", quantity: 1 })]);
      expect(inAustin[0]!.because[0]).toMatch(/on a day you are closed/);
      expect(await afterHours.offersForJob(owner(), { jobId: await jobIn(houston, SAT) })).toEqual([]);
    } finally {
      await afterHours.setRates(owner(), { afterHoursItemId: null, holidayItemId: null });
    }
  });

  it("raises a price by an outside hours pricing rule on Austin's Saturday work and not Houston's", async () => {
    const permissions: Permission[] = ["pricebook:write", "customer:read", "job:read", "visit:read"];
    const app = await apps.install(owner(), {
      name: "Evening pricer", permissions, scopes: { customer: "all", job: "all", visit: "all", estimate: "all", invoice: "all" },
    });
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    const resolved = await apps.resolveToken(db(), token);
    await plugins.registerPricingRule({ actor: resolved!.actor, db: db() }, {
      key: "outside", name: "Outside hours", rule: { kind: "time_window", window: "outside_hours", percent: "50" },
    });
    const line = { quantity: "1", unitPrice: m.money("100.00"), discountAmount: m.money("0.00"), touchable: true, counts: true };
    const priced = async (jobId: string) => (await inTenant(owner(), (tx) =>
      plugins.applyRulesWithin(tx, ORG, { customerId, jobId }, [line])))![0]!;
    expect(m.toString((await priced(await jobIn(austin, SAT))).unitPrice)).toBe("150.0000");
    expect(m.toString((await priced(await jobIn(houston, SAT))).unitPrice)).toBe("100.0000");
  });

  it("counts a crew off for a Houston job when their leave covers Houston's Saturday, and not for an Austin one", async () => {
    const userId = fixtureId("branch-hours:tech");
    await raw`insert into public."user" (id, email) values (${userId}, 'branch-hours-tech@test.local') on conflict (id) do nothing`;
    await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
    const [mem] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
    const [tech] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${mem!.id}, 'Lee Crew') returning id`;
    const crew = await crews.create(owner(), { name: `Crew ${Math.random().toString(36).slice(2, 7)}` });
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: tech!.id, isLead: true }] });
    /** Off from seven until noon on Saturday: all of Houston's day, a morning of the calendar day the company keeps closed. */
    await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${tech!.id}, ${at(SAT, 7)}, ${at(SAT, 12)}, true)`;
    const inHouston = await crews.canTake(owner(), { id: crew.id, jobId: await jobIn(houston, null), on: SAT });
    expect(inHouston.canTake).toBe(false);
    expect(inHouston.blockers.map((b) => b.code)).toContain("everybody_off");
    const inAustin = await crews.canTake(owner(), { id: crew.id, jobId: await jobIn(austin, null), on: SAT });
    expect(inAustin.canTake).toBe(true);
    expect(inAustin.partDayOff.map((p) => p.name)).toEqual(["Lee Crew"]);
  });

  it("counts Houston's Saturday as working hours on a task about a Houston job, and not on an Austin one", async () => {
    const houstonJob = await jobIn(houston, null);
    const austinJob = await jobIn(austin, null);
    for (const [entityId, title] of [[houstonJob, "Houston call back"], [austinJob, "Austin call back"]] as const) {
      await raw`insert into public.task (organization_id, title, status, priority, due_at, entity_type, entity_id)
        values (${ORG}, ${title}, 'open', 'normal', ${at(SAT, 7)}, 'job', ${entityId})`;
    }
    await taskRules.createRule({ ...owner(), idempotencyKey: `bh-rule-${Date.now()}` }, {
      name: "Two working hours", afterHours: 2, workingHours: true, target: "role", targetRole: "owner",
    });
    /** Seven to eleven on Saturday is four of Houston's working hours and none of the company's. */
    const escalated = await taskRules.escalateFor(db(), ORG, at(SAT, 11));
    const titles = new Map((await raw<{ id: string; title: string }[]>`select id, title from public.task where organization_id = ${ORG}`).map((t) => [t.id, t.title]));
    expect(escalated.map((e) => titles.get(e.taskId))).toEqual(["Houston call back"]);
  });

  it("moves a Houston visit onto Houston's Saturday in the several day rebalance, and never an Austin one", async () => {
    const movable: Record<string, string> = {};
    for (const [branchId, label] of [[houston, "houston"], [austin, "austin"]] as const) {
      const jobId = await jobIn(branchId, FRI);
      await raw`update public.visit set status = 'unassigned', movable_from = ${FRI}, movable_until = ${SAT} where job_id = ${jobId}`;
      const [v] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${jobId}`;
      movable[label] = v!.id;
    }
    const proposal = await dispatchDays.rebalanceDays(owner(), { from: FRI, days: 2 });
    expect(proposal.movable.map((v) => v.visitId)).toEqual([movable.houston]);
  });
});
