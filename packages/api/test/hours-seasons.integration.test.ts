import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { time, type Actor } from "@opentradesos/core";
import * as businessHours from "../src/services/business-hours";
import * as booking from "../src/services/booking";
import * as dispatch from "../src/services/dispatch";
import * as dispatchDays from "../src/services/dispatch-days";
import * as serviceRoutes from "../src/services/routes";
import * as numberHours from "../src/services/number-hours";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M02. SEASONS: SUMMER HOURS OVER THE NORMAL WEEK
 *
 * Season Hours Co opens Monday to Friday, eight to five, and is shut at the
 * weekend. For one week in the coming month it keeps "Summer hours": seven
 * to three, and Saturdays too. Its Houston branch keeps a week of its own
 * (Tuesday to Saturday, seven until noon) with a season of its own that shuts
 * Saturdays. Austin keeps the company's week, so it keeps the company's
 * season; Houston keeps only its own. Online booking, a request checked
 * again, the board, a route's fit, the several day rebalance and the phones
 * all read the week in force on the date. Two seasons of one owner that
 * share a day are refused in words.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("hours-seasons:org");
const USER = fixtureId("hours-seasons:user");
const SLUG = "hours-seasons-co";
const ZONE = "America/Chicago";

/** The first Friday at least three days out: the week after it is the season, this one is not. */
const FRI = (() => {
  for (let offset = 3; ; offset += 1) {
    const day = companyToday(offset, ZONE);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 5) return day;
  }
})();
const SAT = time.addDays(FRI, 1);
const SUMMER_FROM = time.addDays(FRI, 3);
const SUMMER_FRI = time.addDays(FRI, 7);
const SUMMER_SAT = time.addDays(FRI, 8);
const SUMMER_UNTIL = time.addDays(FRI, 9);
const at = (date: string, hour: number) => time.instantOfLocal(date, hour * 60, ZONE);

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));
const COMPANY_WEEK = week([1, 2, 3, 4, 5], "08:00", "17:00");
const COMPANY_SUMMER = week([1, 2, 3, 4, 5, 6], "07:00", "15:00");
const HOUSTON_WEEK = week([2, 3, 4, 5, 6], "07:00", "12:00");
const HOUSTON_SUMMER = week([2, 3, 4, 5], "06:00", "11:00");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const keyed = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: `${key}-${Math.random().toString(36).slice(2)}` });
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

async function jobIn(branchId: string, date: string) {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'No cooling', ${branchId}) returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, 'scheduled', ${at(date, 9)}, ${at(date, 11)}, 60) returning id`;
  return visit!.id;
}

/** A technician in a branch, or in none. */
async function technician(key: string, branchId: string | null): Promise<string> {
  const userId = fixtureId(`hours-seasons:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`hours-seasons-${key}@test.local`}) on conflict (id) do nothing`;
  await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${userId}`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, 'technician', ${branchId}) returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${key}) returning id`;
  return t!.id;
}

const summer = (over: Partial<businessHours.SeasonInput> = {}): businessHours.SeasonInput => ({
  name: "Summer hours", startsOn: SUMMER_FROM, endsOn: SUMMER_UNTIL, days: COMPANY_SUMMER, ...over,
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Season Hours Co", slug: SLUG });
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
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Sam Summer') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code,
      latitude, longitude, location_precision, location_source)
    values (${ORG}, '1 Heat Ln', 'Austin', 'TX', '78701', '30.3000000', '-97.7000000', 'rooftop', 'test') returning id`;
  propertyId = p!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["visit", "job", "business_hours", "business_hours_season", "audit_log", "phone_number"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  await businessHours.setWeek(owner(), { days: COMPANY_WEEK });
  await businessHours.setWeek(owner(), { days: HOUSTON_WEEK, businessUnitId: houston });
});

run("keeping a season", () => {
  it("adds, lists, changes and takes off a season, with an audit line for each", async () => {
    const added = await businessHours.addSeason(owner(), summer());
    expect(added).toMatchObject({ name: "Summer hours", businessUnitId: null, branchName: null, startsOn: SUMMER_FROM, endsOn: SUMMER_UNTIL, repeatsYearly: false, inForceToday: false });
    expect(added.days[6]).toEqual({ dayOfWeek: 6, opensAt: "07:00", closesAt: "15:00", closed: false });
    /** The season's rows are not the company's week. */
    expect((await businessHours.list(owner())).company[6]!.closed).toBe(true);

    const houstonOwn = await businessHours.addSeason(owner(), { ...summer({ days: HOUSTON_SUMMER, name: "Houston summer" }), businessUnitId: houston });
    expect(houstonOwn.branchName).toBe("Houston");
    expect((await businessHours.listSeasons(owner())).seasons.map((s) => s.name).sort()).toEqual(["Houston summer", "Summer hours"]);

    const changed = await businessHours.changeSeason(owner(), { id: added.id, ...summer({ name: "Long days", days: COMPANY_SUMMER.map((d) => d.dayOfWeek === 6 ? { ...d, closesAt: "13:00" } : d) }) });
    expect(changed).toMatchObject({ id: added.id, name: "Long days" });
    expect(changed.days[6]!.closesAt).toBe("13:00");
    expect(await raw`select 1 from public.business_hours where season_id = ${added.id}`).toHaveLength(7);

    expect(await businessHours.removeSeason(owner(), { id: added.id })).toEqual({ removed: true });
    expect(await businessHours.removeSeason(owner(), { id: added.id })).toEqual({ removed: false });
    expect(await raw`select 1 from public.business_hours where season_id = ${added.id}`).toHaveLength(0);
    const actions = (await raw<{ action: string }[]>`select action from public.audit_log where organization_id = ${ORG} and entity_type = 'business_hours_season' order by created_at`).map((r) => r.action);
    expect(actions).toEqual(["booking.season.added", "booking.season.added", "booking.season.changed", "booking.season.removed"]);
  });

  it("answers a retried add with the first answer, not a second season", async () => {
    const ctx = keyed("season");
    const first = await businessHours.addSeason(ctx, summer());
    const again = await businessHours.addSeason(ctx, summer());
    expect(again.id).toBe(first.id);
    expect(await raw`select 1 from public.business_hours_season where organization_id = ${ORG}`).toHaveLength(1);
  });

  it("refuses overlapping seasons of one owner in words, and lets another owner's share the days", async () => {
    await businessHours.addSeason(owner(), summer());
    await expect(businessHours.addSeason(owner(), summer({ name: "Heat wave", startsOn: SUMMER_UNTIL, endsOn: time.addDays(SUMMER_UNTIL, 5) })))
      .rejects.toThrow(/overlaps "Summer hours".*A day can keep only one season's hours/);
    /** A season every year meets a dated one on its month and day. */
    await expect(businessHours.addSeason(owner(), summer({ name: "Every year", startsOn: time.addDays(SUMMER_FROM, -365), endsOn: time.addDays(SUMMER_FROM, -360), repeatsYearly: true })))
      .rejects.toThrow(/overlaps "Summer hours"/);
    /** The day after it ends is free. */
    await businessHours.addSeason(owner(), summer({ name: "After", startsOn: time.addDays(SUMMER_UNTIL, 1), endsOn: time.addDays(SUMMER_UNTIL, 3) }));
    /** Houston's own may share the company's days. */
    await businessHours.addSeason(owner(), { ...summer({ days: HOUSTON_SUMMER }), businessUnitId: houston });
    /** Changing one onto another's days is refused the same way. */
    const after = (await businessHours.listSeasons(owner())).seasons.find((s) => s.name === "After")!;
    await expect(businessHours.changeSeason(owner(), { id: after.id, ...summer({ name: "After" }) })).rejects.toThrow(/overlaps "Summer hours"/);
  });

  it("refuses dates that make no sense, and half a week", async () => {
    await expect(businessHours.addSeason(owner(), summer({ startsOn: SUMMER_UNTIL, endsOn: SUMMER_FROM }))).rejects.toThrow(/before it starts/);
    await expect(businessHours.addSeason(owner(), summer({ days: COMPANY_SUMMER.slice(0, 6) }))).rejects.toThrow(/Send all seven days/);
  });

  it("lets the Austin manager keep Austin's seasons and nobody else's, and shows them the company's and Austin's", async () => {
    await expect(businessHours.addSeason(manager(), summer())).rejects.toThrow(/You set your own branch's hours/);
    await expect(businessHours.addSeason(manager(), { ...summer(), businessUnitId: houston })).rejects.toThrow(/You set your own branch's hours/);
    const houstons = await businessHours.addSeason(owner(), { ...summer({ name: "Houston summer", days: HOUSTON_SUMMER }), businessUnitId: houston });
    await businessHours.addSeason(owner(), summer());
    await businessHours.addSeason(manager(), { ...summer({ name: "Austin summer" }), businessUnitId: austin });
    expect((await businessHours.listSeasons(manager())).seasons.map((s) => s.name).sort()).toEqual(["Austin summer", "Summer hours"]);
    await expect(businessHours.changeSeason(manager(), { id: houstons.id, ...summer() })).rejects.toThrow(/Season/);
    await expect(businessHours.removeSeason(manager(), { id: houstons.id })).rejects.toThrow(/Season/);
  });
});

run("every reader reads the week in force on the date", () => {
  beforeEach(async () => {
    if (!url) return;
    await businessHours.addSeason(owner(), summer());
    await businessHours.addSeason(owner(), { ...summer({ name: "Houston summer", days: HOUSTON_SUMMER }), businessUnitId: houston });
  });

  it("offers Austin's Saturday only in the company's season, and shuts Houston's Saturday in its own", async () => {
    expect(await slots(austinService, SAT)).toEqual([]);
    expect(await slots(austinService, SUMMER_SAT)).toHaveLength(1);
    expect(await slots(houstonService, SAT)).toHaveLength(1);
    expect(await slots(houstonService, SUMMER_SAT)).toEqual([]);
  });

  it("refuses a booking request on a day a season has since shut", async () => {
    await expect(booking.createRequest(db(), {
      organizationSlug: SLUG, bookableServiceId: houstonService, requestedDate: SUMMER_SAT, arrivalWindowId: morning,
      contactName: "Sam Summer", contactPhone: "+15125550100", addressLine1: "1 Heat Ln", city: "Houston", state: "TX",
      postalCode: "77001", intakeAnswers: {}, utm: {},
    })).rejects.toThrow(/We are closed on/);
  });

  it("says on the board what the shop keeps that day", async () => {
    expect((await dispatch.board(owner(), { date: SAT })).hours).toMatchObject({ closed: true, season: null, words: "Closed on Saturdays." });
    expect((await dispatch.board(owner(), { date: SUMMER_SAT })).hours)
      .toMatchObject({ closed: false, season: "Summer hours", opensAt: "07:00", closesAt: "15:00", words: "Open 7:00 AM to 3:00 PM, Summer hours." });
    expect((await dispatch.board(owner(), { date: SUMMER_SAT, businessUnitId: houston })).hours)
      .toMatchObject({ branchId: houston, closed: true, words: "Closed on Saturdays in Houston summer." });
  });

  it("fits a route on a summer date to the season's day, and the template to the normal week", async () => {
    const route = await serviceRoutes.create(owner(), {
      name: "Saturday pools", dayOfWeek: 6, travelMinutesBetweenStops: 10, technicianId: await technician("dana", null),
    });
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '2 Pool Lane', 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${p!.id})`;
    await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId: p!.id, estimatedMinutes: 20 });
    expect((await serviceRoutes.density(owner(), { id: route.id })).dayBasis).toBe("unknown");
    expect(await serviceRoutes.density(owner(), { id: route.id, on: SAT })).toMatchObject({ dayBasis: "closed" });
    expect(await serviceRoutes.density(owner(), { id: route.id, on: SUMMER_SAT }))
      .toMatchObject({ dayBasis: "business_hours", openMinutes: 480, overtimeAfterMinutes: 480 });
  });

  it("says a season shut the day when a route's date falls on a weekday it keeps closed", async () => {
    const route = await serviceRoutes.create(owner(), {
      name: "Houston Saturday", dayOfWeek: 6, travelMinutesBetweenStops: 10, technicianId: await technician("hal", houston),
    });
    expect(await serviceRoutes.density(owner(), { id: route.id, on: SUMMER_SAT }))
      .toMatchObject({ dayBasis: "closed", closedOn: `In Houston summer you are closed on Saturdays, so ${SUMMER_SAT} is not a working day.` });
    expect((await serviceRoutes.density(owner(), { id: route.id, on: SAT })).dayBasis).toBe("business_hours");
  });

  it("moves an Austin visit onto the summer Saturday in the several day rebalance, and never a Houston one", async () => {
    const movable: Record<string, string> = {};
    for (const [branchId, label] of [[houston, "houston"], [austin, "austin"]] as const) {
      const visitId = await jobIn(branchId, SUMMER_FRI);
      await raw`update public.visit set status = 'unassigned', movable_from = ${SUMMER_FRI}, movable_until = ${SUMMER_SAT} where id = ${visitId}`;
      movable[label] = visitId;
    }
    const proposal = await dispatchDays.rebalanceDays(owner(), { from: SUMMER_FRI, days: 2 });
    expect(proposal.movable.map((v) => v.visitId)).toEqual([movable.austin]);
    /** Outside the season the other way round: Houston opens Saturdays, Austin does not. */
    await raw`delete from public.visit where organization_id = ${ORG}`;
    for (const [branchId, label] of [[houston, "houston"], [austin, "austin"]] as const) {
      const visitId = await jobIn(branchId, FRI);
      await raw`update public.visit set status = 'unassigned', movable_from = ${FRI}, movable_until = ${SAT} where id = ${visitId}`;
      movable[label] = visitId;
    }
    expect((await dispatchDays.rebalanceDays(owner(), { from: FRI, days: 2 })).movable.map((v) => v.visitId)).toEqual([movable.houston]);
  });

  it("routes a phone that follows its branch by the season in force, and one on its own week by its own", async () => {
    const [n] = await raw<{ id: string }[]>`insert into public.phone_number (organization_id, e164, purpose, business_unit_id, hours_from, route_by_hours)
      values (${ORG}, '+15125550199', 'main', ${houston}, 'branch', true) returning id`;
    const number = (await inTenant(owner(), (tx) => tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, n!.id))))[0]!;
    const inSummer = await inTenant(owner(), (tx) => numberHours.hoursOfNumber(tx, ORG, number, SUMMER_SAT));
    expect(inSummer.season).toBe("Houston summer");
    expect(inSummer.rows.find((r) => r.dayOfWeek === 6)!.closed).toBe(true);
    const outside = await inTenant(owner(), (tx) => numberHours.hoursOfNumber(tx, ORG, number, SAT));
    expect(outside.season).toBeNull();
    expect(outside.rows.find((r) => r.dayOfWeek === 6)!.closed).toBe(false);

    await numberHours.setHours(owner(), { id: number.id, hoursFrom: "own", days: week([0, 1, 2, 3, 4, 5, 6], "00:00", "23:59") });
    const own = (await inTenant(owner(), (tx) => tx.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, n!.id))))[0]!;
    const ownSummer = await inTenant(owner(), (tx) => numberHours.hoursOfNumber(tx, ORG, own, SUMMER_SAT));
    expect(ownSummer.season).toBeNull();
    expect(ownSummer.rows.find((r) => r.dayOfWeek === 6)!.closed).toBe(false);
  });
});
