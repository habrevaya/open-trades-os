import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { type Actor } from "@opentradesos/core";
import * as holidays from "../src/services/holidays";
import * as booking from "../src/services/booking";
import * as afterHours from "../src/services/after-hours";
import * as priceBook from "../src/services/pricebook";
import * as rules from "../src/services/task-rules";
import * as dispatchDays from "../src/services/dispatch-days";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * HOLIDAYS THAT MOVE, AND A BRANCH'S OWN
 *
 * Holiday Branches Co has two branches, Austin and Houston. It closes on
 * Thanksgiving, entered once as "the fourth Thursday of November", and on
 * Christmas, kept on the Monday after when it falls on a Sunday. Houston
 * also closes for a day of its own. Houston's booking page offers nothing
 * that day and Austin's offers it as usual; a Houston job booked that day is
 * offered the holiday rate and an Austin one is not; a task about a Houston
 * job does not count that day as working hours. The Austin manager keeps
 * Austin's own days and may not change the company's or see Houston's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("holiday-branches:org");
const USER = fixtureId("holiday-branches:user");
const ZONE = "America/Chicago";
const DAY = companyToday(12, ZONE);

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
let customerId = "";
let propertyId = "";
let holidayItem = "";

async function slots(serviceId: string, date: string) {
  const [service] = await inTenant(owner(), (tx) =>
    tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
  return booking.openSlots(db(), { organizationId: ORG, timezone: ZONE, service: service!, from: date, days: 1 });
}

async function jobIn(branchId: string, date: string) {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'No heat', ${branchId}) returning id`;
  await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, 'scheduled', (${`${date}T09:00`}::timestamp at time zone ${ZONE}),
            (${`${date}T11:00`}::timestamp at time zone ${ZONE}), 60)`;
  return job!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Holiday Branches Co", slug: "holiday-branches-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  await raw`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week, sort_order)
    values (${ORG}, 'Morning', '08:00', '11:00', ${[0, 1, 2, 3, 4, 5, 6]}, 1)`;
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
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Cold') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Frost Ln', 'Houston', 'TX', '77001') returning id`;
  propertyId = p!.id;
  holidayItem = (await priceBook.create(owner(), { kind: "fee", code: "HOL", name: "Holiday call-out", price: "300.00", taxable: false })).id;
  await afterHours.setRates(owner(), { afterHoursItemId: null, holidayItemId: holidayItem });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["company_holiday", "task_escalation", "task", "task_escalation_rule", "visit", "job"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("holidays that move", () => {
  it("keeps Thanksgiving as a rule and works out each year's date", async () => {
    const thanksgiving = await holidays.create(owner(), {
      name: "Thanksgiving", rule: { month: 11, weekday: 4, week: 4 }, closed: true,
    });
    expect(thanksgiving).toMatchObject({ repeatsYearly: true, when: "Fourth Thursday of November", businessUnitId: null });
    const today = companyToday(0, ZONE);
    const year = Number(today.slice(0, 4));
    const thisYear = (await import("@opentradesos/core")).holidays.weekdayOfMonth(year, { month: 11, weekday: 4, week: 4 });
    expect(thanksgiving.nextOn).toBe(thisYear >= today
      ? thisYear
      : (await import("@opentradesos/core")).holidays.weekdayOfMonth(year + 1, { month: 11, weekday: 4, week: 4 }));
    /** A fixed date that meets it in some year of the next ten is refused, in words. */
    await expect(holidays.create(owner(), { name: "Late November", date: "2020-11-26", repeatsYearly: true, closed: true }))
      .rejects.toThrow(/"Thanksgiving" is already on the list on \d{4}-11-26/);
  });

  it("keeps Christmas on the Monday after a Sunday, and refuses that rule on a one off date", async () => {
    const christmas = await holidays.create(owner(), {
      name: "Christmas", date: "2020-12-25", repeatsYearly: true, observed: "sunday_to_monday", closed: true,
    });
    expect(christmas.when).toBe("Every year on December 25, or the Monday after when it falls on a Sunday");
    await expect(holidays.create(owner(), { name: "Once", date: "2027-12-25", observed: "sunday_to_monday", closed: true }))
      .rejects.toThrow(/Only a holiday that comes back every year/);
    await expect(holidays.create(owner(), { name: "Nothing", closed: true }))
      .rejects.toThrow(/Say which date it is/);
    /** Online booking reads the moved day: 2033-12-25 is a Sunday, so Monday the 26th is closed. */
    const list = await holidays.loadHolidays(db(), ORG);
    const core = (await import("@opentradesos/core")).holidays;
    expect(core.closedOn(list, "2033-12-26")).toBe(true);
    expect(core.closedOn(list, "2033-12-25")).toBe(false);
  });
});

run("a branch's own holidays", () => {
  it("closes Houston's booking page that day and leaves Austin's open", async () => {
    expect(await slots(houstonService, DAY)).toHaveLength(1);
    await holidays.create(owner(), { name: "Houston rodeo", date: DAY, closed: true, businessUnitId: houston });
    expect(await slots(houstonService, DAY)).toEqual([]);
    expect(await slots(austinService, DAY)).toHaveLength(1);
    /** The company's own days still close both. */
    await holidays.create(owner(), { name: "Shop party", date: companyToday(13, ZONE), closed: true });
    expect(await slots(austinService, companyToday(13, ZONE))).toEqual([]);
  });

  it("offers the holiday rate on a Houston job that day and not on an Austin one", async () => {
    await holidays.create(owner(), { name: "Houston rodeo", date: DAY, closed: true, businessUnitId: houston });
    const inHouston = await afterHours.offersForJob(owner(), { jobId: await jobIn(houston, DAY) });
    expect(inHouston).toEqual([expect.objectContaining({ kind: "holiday", quantity: 1 })]);
    expect(inHouston[0]!.because[0]).toMatch(/Houston rodeo/);
    expect(await afterHours.offersForJob(owner(), { jobId: await jobIn(austin, DAY) })).toEqual([]);
  });

  it("does not count Houston's day off as working hours on a task about a Houston job", async () => {
    /** Due at nine the day before Houston's day off, looked at at five on the day off, under a twelve working hour rule. */
    const before = companyToday(11, ZONE);
    await holidays.create(owner(), { name: "Houston rodeo", date: DAY, closed: true, businessUnitId: houston });
    const houstonJob = await jobIn(houston, DAY);
    const austinJob = await jobIn(austin, DAY);
    const due = new Date((await raw<{ t: Date }[]>`select (${`${before}T09:00`}::timestamp at time zone ${ZONE}) as t`)[0]!.t);
    const now = new Date((await raw<{ t: Date }[]>`select (${`${DAY}T17:00`}::timestamp at time zone ${ZONE}) as t`)[0]!.t);
    for (const [entityId, title] of [[houstonJob, "Houston call back"], [austinJob, "Austin call back"]] as const) {
      await raw`insert into public.task (organization_id, title, status, priority, due_at, entity_type, entity_id)
        values (${ORG}, ${title}, 'open', 'normal', ${due}, 'job', ${entityId})`;
    }
    /** Nine to six the day before is nine working hours; the day off adds none in Houston and ten in Austin. */
    await raw`insert into public.task_escalation_rule (organization_id, name, after_hours, working_hours, target, target_role)
      values (${ORG}, 'Twelve working hours', 12, true, 'role', 'owner')`;
    const escalated = await rules.escalateFor(db(), ORG, now);
    const late = await raw<{ id: string; title: string }[]>`select id, title from public.task where organization_id = ${ORG} and entity_type = 'job'`;
    const title = new Map(late.map((t) => [t.id, t.title]));
    expect(escalated.map((e) => title.get(e.taskId))).toEqual(["Austin call back"]);
  });

  it("moves no Houston visit onto Houston's day off in the several day rebalance, and an Austin one still may", async () => {
    const from = companyToday(11, ZONE);
    await holidays.create(owner(), { name: "Houston rodeo", date: DAY, closed: true, businessUnitId: houston });
    await raw`update public.property set latitude = '30.3000000', longitude = '-97.7000000', location_precision = 'rooftop', location_source = 'test' where id = ${propertyId}`;
    const movable: Record<string, string> = {};
    for (const [branchId, label] of [[houston, "houston"], [austin, "austin"]] as const) {
      const jobId = await jobIn(branchId, from);
      await raw`update public.visit set status = 'unassigned', movable_from = ${from}, movable_until = ${DAY} where job_id = ${jobId}`;
      const [v] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${jobId}`;
      movable[label] = v!.id;
    }
    const proposal = await dispatchDays.rebalanceDays(owner(), { from, days: 2 });
    expect(proposal.movable.map((m) => m.visitId)).toEqual([movable.austin]);
  });

  it("is kept by the branch's own manager, who may not change the company's list or see another branch's", async () => {
    const houstons = await holidays.create(owner(), { name: "Houston rodeo", date: DAY, closed: true, businessUnitId: houston });
    await holidays.create(owner(), { name: "Shop party", date: companyToday(13, ZONE), closed: true });
    await expect(holidays.create(manager(), { name: "Everyone off", date: companyToday(14, ZONE), closed: true }))
      .rejects.toThrow(/You keep your own branch's holidays/);
    await expect(holidays.create(manager(), { name: "Theirs", date: companyToday(14, ZONE), closed: true, businessUnitId: houston }))
      .rejects.toThrow(/You keep your own branch's holidays/);
    const own = await holidays.create(manager(), { name: "Austin picnic", date: companyToday(14, ZONE), closed: true, businessUnitId: austin });
    expect(own).toMatchObject({ businessUnitId: austin, branchName: "Austin" });
    expect((await holidays.list(manager())).map((h) => h.name).sort()).toEqual(["Austin picnic", "Shop party"]);
    await expect(holidays.remove(manager(), { id: houstons.id })).rejects.toThrow(/Holiday/);
    /** A branch's own day and the company's on one date: the branch's is read first. */
    await holidays.create(owner(), { name: "Austin short day", date: DAY, closed: false, opensAt: "08:00", closesAt: "12:00", businessUnitId: austin });
    expect(await slots(austinService, DAY)).toHaveLength(1);
    expect(await slots(houstonService, DAY)).toEqual([]);
  });
});
