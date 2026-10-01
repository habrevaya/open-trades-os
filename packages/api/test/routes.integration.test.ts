import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as serviceRoutes from "../src/services/routes";
import * as crews from "../src/services/crews";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * ROUTES, AND WHETHER THE DAY FITS
 *
 * Pool, pest, lawn, cleaning, gutters and snow sell a stop on a route rather
 * than an appointment. `route` and `route_stop` shipped in the first
 * migration and nothing ever wrote either, so a company whose whole business
 * is a Tuesday route would have run this product as a list of unrelated jobs,
 * which is the system they were leaving.
 *
 * TWO PROPERTIES THIS FILE IS ABOUT.
 *
 * MATERIALISING THE SAME ROUTE FOR THE SAME DATE TWICE MUST NOT DOUBLE BOOK
 * THE CUSTOMER. A timer runs this, timers retry, and the person who finds out
 * is the customer watching two vans pull up.
 *
 * AND DENSITY IS ANSWERED WITH ITS CAVEATS. There is no geocoding here, so
 * travel is what the operator declared and nothing else. Undeclared, the
 * total is a floor and the answer to "will this run into overtime" is null
 * rather than a comfortable no.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("svcroutes:org");
const USER = fixtureId("svcroutes:user");

/** 2026-06-02 is a Tuesday and 2026-06-04 is a Thursday. */
const TUESDAY = "2026-06-02";
const NEXT_TUESDAY = "2026-06-09";
const THURSDAY = "2026-06-04";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let technicianId = "";
let customerId = "";

async function technician(key: string, name: string): Promise<string> {
  const userId = fixtureId(`svcroutes:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`svcroutes-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

/** A property with a customer on it, which is what a stop needs to be billable. */
async function property(address: string, withCustomer = true): Promise<string> {
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${address}, 'Austin', 'TX', '78701') returning id`;
  if (withCustomer) {
    await raw`insert into public.customer_property (organization_id, customer_id, property_id)
              values (${ORG}, ${customerId}, ${p!.id})`;
  }
  return p!.id;
}

async function overtimePolicy(dailyThresholdMinutes: number | null): Promise<void> {
  await raw`
    insert into public.overtime_policy
      (organization_id, label, time_zone, week_starts_on, day_attribution,
       daily_threshold_minutes, overtime_multiplier, double_time_multiplier,
       on_call_treatment, note)
    values (${ORG}, 'Test policy', 'America/Chicago', 0, 'shift_start',
            ${dailyThresholdMinutes}, '1.5', '2',
            'separate_rate_not_hours_worked', 'A fixture, not advice.')`;
}

async function businessHours(dayOfWeek: number, opens: string, closes: string): Promise<void> {
  await raw`
    insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at, closed)
    values (${ORG}, ${dayOfWeek}, ${opens}, ${closes}, false)`;
}

/** A Tuesday route served by a technician, with `count` twenty minute stops. */
async function aRoute(count: number, over: Partial<serviceRoutes.RouteInput> = {}) {
  const route = await serviceRoutes.create(owner(), {
    name: "Tuesday pool route", dayOfWeek: 2, technicianId, ...over,
  });
  const stopIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const stop = await serviceRoutes.addStop(owner(), {
      routeId: route.id,
      propertyId: await property(`${i + 1} Pool Lane`),
      estimatedMinutes: 20,
    });
    stopIds.push(stop.id);
  }
  return { route, stopIds };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pool Co", slug: "pool-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'residential', 'Route Customer') returning id`;
  customerId = customer!.id;
  technicianId = await technician("driver", "Dana");
});

/* ------------------------------------------------------------ the route */

run("defining a route", () => {
  it("refuses a route with nobody to serve it", async () => {
    /**
     * Visits from a servicer-less route land on the board looking exactly
     * like work nobody has got to yet, and they sit there.
     */
    await expect(serviceRoutes.create(owner(), { name: "Orphan route", dayOfWeek: 2 }))
      .rejects.toThrow(/needs somebody to serve it/);
  });

  it("refuses a route served by a technician and a crew at once", async () => {
    const crew = await crews.create(owner(), { name: "Pool crew" });
    await expect(serviceRoutes.create(owner(), {
      name: "Two servicers", dayOfWeek: 2, technicianId, crewId: crew.id,
    })).rejects.toThrow(/not both/);
  });

  it("refuses a weekday that is not a weekday", async () => {
    await expect(serviceRoutes.create(owner(), {
      name: "Eighth day", dayOfWeek: 7, technicianId,
    })).rejects.toThrow(/0 for Sunday through 6/);
  });

  it("refuses a technician who is not active here", async () => {
    await expect(serviceRoutes.create(owner(), {
      name: "Ghost route", dayOfWeek: 2, technicianId: fixtureId("svcroutes:nobody"),
    })).rejects.toThrow(/not active in this company/);
  });
});

/* ------------------------------------------------------------- the stops */

run("the stops", () => {
  it("numbers them in the order they are added", async () => {
    const { route } = await aRoute(0);
    const first = await serviceRoutes.addStop(owner(), {
      routeId: route.id, propertyId: await property("1 Pool Lane"),
    });
    const second = await serviceRoutes.addStop(owner(), {
      routeId: route.id, propertyId: await property("2 Pool Lane"),
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
  });

  it("refuses the same property twice on one route", async () => {
    /**
     * Two stops at one address is a double booking written into the template:
     * every materialisation forever produces the pair, and at a price per
     * stop the customer is billed twice.
     */
    const { route } = await aRoute(0);
    const propertyId = await property("1 Pool Lane");
    await serviceRoutes.addStop(owner(), { routeId: route.id, propertyId });
    await expect(serviceRoutes.addStop(owner(), { routeId: route.id, propertyId }))
      .rejects.toThrow(/already a stop on this route/);
  });

  it("refuses a stop that takes no time", async () => {
    const { route } = await aRoute(0);
    await expect(serviceRoutes.addStop(owner(), {
      routeId: route.id, propertyId: await property("1 Pool Lane"), estimatedMinutes: 0,
    })).rejects.toThrow(/makes every density figure a lie/);
  });
});

run("reordering a route", () => {
  it("renumbers the whole route from one", async () => {
    const { route, stopIds } = await aRoute(3);
    const reversed = [...stopIds].reverse();
    await serviceRoutes.reorder(owner(), { id: route.id, stopIds: reversed });

    const after = await serviceRoutes.stops(owner(), { id: route.id });
    expect(after.map((s) => s.id)).toEqual(reversed);
    expect(after.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  it("refuses an order that leaves stops out", async () => {
    /**
     * A partial order renumbers the stops it names and leaves the rest, which
     * produces two stops sharing a number and a driver going back across the
     * territory for one of them.
     */
    const { route, stopIds } = await aRoute(3);
    await expect(serviceRoutes.reorder(owner(), { id: route.id, stopIds: stopIds.slice(0, 2) }))
      .rejects.toThrow(/leaves out 1 of this route's stops/);
  });

  it("refuses a stop from somebody else's route", async () => {
    const { route } = await aRoute(1);
    const other = await aRoute(1, { name: "Wednesday route", dayOfWeek: 3 });
    await expect(serviceRoutes.reorder(owner(), {
      id: route.id, stopIds: [...other.stopIds],
    })).rejects.toThrow(/not active stops on this route/);
  });

  it("refuses an order naming the same stop twice", async () => {
    const { route, stopIds } = await aRoute(2);
    await expect(serviceRoutes.reorder(owner(), {
      id: route.id, stopIds: [stopIds[0]!, stopIds[0]!],
    })).rejects.toThrow(/same stop twice/);
  });
});

/* --------------------------------------------------------- materialising */

run("turning a route into a day's work", () => {
  it("creates a job and a visit for every stop, in route order", async () => {
    const { route, stopIds } = await aRoute(3);
    const result = await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });

    expect(result.created.length).toBe(3);
    const rows = await raw<{ route_order: number; route_stop_id: string; status: string }[]>`
      select route_order, route_stop_id, status from public.visit
      where organization_id = ${ORG} and route_id = ${route.id} order by route_order`;
    expect(rows.map((r) => r.route_order)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.route_stop_id)).toEqual(stopIds);
    // Scheduled, not unassigned: a route HAS a servicer, and forty route
    // visits in the unassigned pile every Tuesday is a board nobody can use.
    expect(rows.every((r) => r.status === "scheduled")).toBe(true);
  });

  it("does not double book the customer when it runs twice", async () => {
    /**
     * THE PROPERTY THIS SERVICE IS MOSTLY ABOUT. A timer runs this and timers
     * retry. The same stop and date is one job, and the second pass counts it
     * rather than creating it again.
     */
    const { route } = await aRoute(3);
    const first = await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });
    const second = await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });

    expect(first.created.length).toBe(3);
    expect(second.created.length).toBe(0);
    expect(second.alreadyThere).toBe(3);

    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.visit
      where organization_id = ${ORG} and route_id = ${route.id}`;
    expect(count?.n).toBe(3);
  });

  it("still creates next week, which is a different day and not a duplicate", async () => {
    // The pair is the identity. Keying on the stop alone would make every
    // week after the first look like a duplicate of it.
    const { route } = await aRoute(2);
    await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });
    const next = await serviceRoutes.materialise(owner(), { id: route.id, date: NEXT_TUESDAY });
    expect(next.created.length).toBe(2);
  });

  it("refuses the wrong weekday", async () => {
    /**
     * Materialising the Tuesday route onto a Thursday is a mistyped date, and
     * the only way back is deleting forty jobs by hand.
     */
    const { route } = await aRoute(2);
    await expect(serviceRoutes.materialise(owner(), { id: route.id, date: THURSDAY }))
      .rejects.toThrow(/runs on Tuesday and 2026-06-04 is a Thursday/);
  });

  it("refuses a paused route", async () => {
    const { route } = await aRoute(1);
    await raw`update public.route set active = false where id = ${route.id}`;
    await expect(serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY }))
      .rejects.toThrow(/paused/);
  });

  it("leaves out a stop that is not due by its own cadence", async () => {
    /**
     * A route runs every Tuesday and a stop on it may be fortnightly. The
     * next date is counted from when the technician was ACTUALLY there, which
     * is what makes a rain week shift the series instead of losing a visit.
     */
    const { route, stopIds } = await aRoute(2);
    await raw`update public.route_stop set interval_days = 14, last_serviced_on = ${TUESDAY}
              where id = ${stopIds[0]!}`;

    const result = await serviceRoutes.materialise(owner(), { id: route.id, date: NEXT_TUESDAY });
    expect(result.created.length).toBe(1);
    expect(result.notDue).toEqual([{ stopId: stopIds[0]!, dueOn: "2026-06-16" }]);
  });

  it("leaves out a stop somebody took off the route", async () => {
    const { route, stopIds } = await aRoute(2);
    await serviceRoutes.setStopActive(owner(), { id: stopIds[0]!, active: false });
    const result = await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });
    expect(result.created.map((c) => c.stopId)).toEqual([stopIds[1]!]);
  });

  it("refuses a stop at a property with no customer, rather than quietly skipping it", async () => {
    /**
     * A route that silently produced thirty nine of forty visits would be
     * short one invoice every week with nothing on any screen saying which.
     */
    const { route } = await aRoute(1);
    await serviceRoutes.addStop(owner(), {
      routeId: route.id, propertyId: await property("Nobody's house", false),
    });
    await expect(serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY }))
      .rejects.toThrow(/no customer on it/);
  });

  it("puts a technician route into the dispatch board's own assignment table", async () => {
    /**
     * This is what makes route work sit BESIDE technician dispatch rather
     * than beside the product. The existing board draws these visits and the
     * existing assign endpoint can move one when somebody calls in sick.
     */
    const { route } = await aRoute(2);
    await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });
    const rows = await raw<{ technician_id: string }[]>`
      select va.technician_id from public.visit_assignment va
      join public.visit v on v.id = va.visit_id
      where v.route_id = ${route.id}`;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.technician_id === technicianId)).toBe(true);
  });

  it("puts a crew route on the crew column instead, and writes no assignment", async () => {
    // The schema's rule: exactly one of visit.crew_id and visit_assignment.
    const crew = await crews.create(owner(), { name: "Pool crew" });
    // With somebody on it, so "no assignment row" is a real absence rather
    // than an absence for want of anybody to assign.
    await crews.setMembers(owner(), {
      id: crew.id, members: [{ technicianId: await technician("crew-hand", "Cal") }],
    });
    const { route } = await aRoute(2, { name: "Crew route", technicianId: null, crewId: crew.id });
    await serviceRoutes.materialise(owner(), { id: route.id, date: TUESDAY });

    const visits = await raw<{ crew_id: string | null }[]>`
      select crew_id from public.visit where route_id = ${route.id}`;
    expect(visits.every((v) => v.crew_id === crew.id)).toBe(true);

    const assignments = await raw`
      select va.id from public.visit_assignment va
      join public.visit v on v.id = va.visit_id where v.route_id = ${route.id}`;
    expect(assignments.length).toBe(0);
  });
});

run("recording that the technician was really there", () => {
  it("counts the next visit from the completion, not the calendar", async () => {
    const { stopIds } = await aRoute(1);
    await raw`update public.route_stop set interval_days = 7 where id = ${stopIds[0]!}`;
    const result = await serviceRoutes.recordServiced(owner(), {
      id: stopIds[0]!, servicedOn: THURSDAY,
    });
    expect(result.nextDueOn).toBe("2026-06-11");
  });

  it("refuses a backdated completion", async () => {
    /**
     * The series counts forward from this date, so accepting an earlier one
     * silently reschedules everything after it.
     */
    const { stopIds } = await aRoute(1);
    await serviceRoutes.recordServiced(owner(), { id: stopIds[0]!, servicedOn: NEXT_TUESDAY });
    await expect(serviceRoutes.recordServiced(owner(), { id: stopIds[0]!, servicedOn: TUESDAY }))
      .rejects.toThrow(/pull every future visit backwards/);
  });
});

/* ---------------------------------------------------------------- density */

run("will the day fit", () => {
  it("will not claim a day fits when nobody has said how far apart the stops are", async () => {
    /**
     * THE CLAIM THIS SERVICE MUST NOT MAKE. With no declared drive time the
     * stop total is a FLOOR, and reporting "no, it does not run into
     * overtime" from a floor is telling an operator a fifteen stop day fits
     * on the strength of pretending the driving is free.
     */
    await overtimePolicy(480);
    const { route } = await aRoute(10);
    const answer = await serviceRoutes.density(owner(), { id: route.id });

    expect(answer.travelDeclared).toBe(false);
    expect(answer.travelMinutes).toBeNull();
    expect(answer.totalMinutes).toBe(200);
    expect(answer.runsIntoOvertime).toBeNull();
    expect(answer.explanation).toMatch(/without a drive time nobody can say/);
  });

  it("does say so when the stop time alone already runs over", async () => {
    // A floor past the threshold is a real yes: the undeclared travel can
    // only make it worse.
    await overtimePolicy(480);
    const { route } = await aRoute(25);
    const answer = await serviceRoutes.density(owner(), { id: route.id });
    expect(answer.totalMinutes).toBe(500);
    expect(answer.runsIntoOvertime).toBe(true);
    expect(answer.minutesOverThreshold).toBe(20);
  });

  it("counts travel between stops once the operator declares it", async () => {
    await overtimePolicy(480);
    const { route } = await aRoute(10, { travelMinutesBetweenStops: 10 });
    const answer = await serviceRoutes.density(owner(), { id: route.id });
    // Nine hops between ten stops, not ten. The drive from the yard to the
    // first stop is nobody's recorded number and is deliberately not guessed.
    expect(answer.travelMinutes).toBe(90);
    expect(answer.totalMinutes).toBe(290);
    expect(answer.runsIntoOvertime).toBe(false);
  });

  it("answers the question an operator actually asks: what if I add this customer", async () => {
    /**
     * The fifteenth stop is the only decision that matters in a route
     * business, and today it is made by feel and the answer arrives on Friday
     * at time and a half.
     */
    await overtimePolicy(480);
    const { route } = await aRoute(14, { travelMinutesBetweenStops: 15 });
    const before = await serviceRoutes.density(owner(), { id: route.id });
    // 280 minutes of stops and 195 of driving, five minutes inside the day.
    expect(before.totalMinutes).toBe(475);
    expect(before.runsIntoOvertime).toBe(false);

    const after = await serviceRoutes.density(owner(), { id: route.id, addingStopOfMinutes: 45 });
    expect(after.stopCount).toBe(15);
    expect(after.totalMinutes).toBe(14 * 20 + 45 + 14 * 15);
    expect(after.runsIntoOvertime).toBe(true);
    expect(after.explanation).toMatch(/runs into overtime/);
  });

  it("will not guess a working day nobody has declared", async () => {
    /**
     * `services/labor.ts` refuses to run a timesheet without a policy because
     * every default is a position on what somebody is owed. The same
     * reasoning, with a softer consequence: the density figure is still
     * useful, and the overtime answer is null with the remedy named.
     */
    const { route } = await aRoute(10, { travelMinutesBetweenStops: 10 });
    const answer = await serviceRoutes.density(owner(), { id: route.id });
    expect(answer.overtimeAfterMinutes).toBeNull();
    expect(answer.dayBasis).toBe("unknown");
    expect(answer.runsIntoOvertime).toBeNull();
    expect(answer.explanation).toMatch(/neither a daily overtime threshold nor business hours/);
  });

  it("falls back to the declared business hours for that weekday", async () => {
    await businessHours(2, "08:00:00", "16:00:00");
    const { route } = await aRoute(10, { travelMinutesBetweenStops: 10 });
    const answer = await serviceRoutes.density(owner(), { id: route.id });
    expect(answer.dayBasis).toBe("business_hours");
    expect(answer.overtimeAfterMinutes).toBe(480);
  });

  it("prefers the overtime policy, which is the minute overtime really starts", async () => {
    /**
     * Business hours say when the office is open. The policy's daily
     * threshold says when the next minute costs time and a half, and they are
     * not the same statement.
     */
    await businessHours(2, "08:00:00", "16:00:00");
    await overtimePolicy(600);
    const { route } = await aRoute(10, { travelMinutesBetweenStops: 10 });
    const answer = await serviceRoutes.density(owner(), { id: route.id });
    expect(answer.dayBasis).toBe("overtime_policy");
    expect(answer.overtimeAfterMinutes).toBe(600);
  });

  it("says when the route is past the stop count its owner manages to", async () => {
    const { route } = await aRoute(12, { targetStopCount: 10 });
    const answer = await serviceRoutes.density(owner(), { id: route.id });
    expect(answer.overTarget).toBe(true);
  });

  it("refuses rather than answering a density question that is not a question", async () => {
    const { route } = await aRoute(1);
    await expect(serviceRoutes.density(owner(), { id: route.id, addingStopOfMinutes: -5 }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
