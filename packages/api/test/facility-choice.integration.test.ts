import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { geo, rental as rt, time, type Actor } from "@opentradesos/core";
import * as facilities from "../src/services/disposal-facilities";
import * as dispatchMap from "../src/services/dispatch-map";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A DRIVER'S DAY AMONG SEVERAL DISPOSAL FACILITIES, AND THE HOLIDAYS EACH KEEPS
 *
 * Each full container goes to the nearest facility that is open when the truck
 * gets there. One shut that day by its hours or by a holiday it keeps is skipped,
 * and the day's plan says which facility each haul goes to and why. The
 * arithmetic is core's; this proves it through rows: the company's facilities
 * read from the database, their pins, hours and holiday lists, and the answer.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("fc:org");
const USER = fixtureId("fc:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});

const day = companyToday(9);
const weekday = rt.weekdayOf(day);
let driverId = "";
const stops: Record<string, string> = {};
const ids: Record<string, string> = {};

/** A pin on the driver's line of latitude, so distance is the difference in longitude. */
async function facility(name: string, longitude: number, extra: Partial<facilities.FacilityInput> = {}) {
  const made = await facilities.createFacility(owner(), { name, tipMinutes: 15, ...extra });
  await facilities.pinFacility(owner(), { id: made.id, latitude: 30.30, longitude });
  ids[name] = made.id;
  return made.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Many Landfills", slug: "facility-choice-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;

  const [yard] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
    values (${ORG}, 'Yard', '1 Yard Rd', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(-97.75)}, 'placed', 'manual')
    returning id`;
  const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} limit 1`;
  const [driver] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, home_location_id)
    values (${ORG}, ${m!.id}, 'Tia Driver', ${yard!.id}) returning id`;
  driverId = driver!.id;
  const [drop] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
    values (${ORG}, 'Delivery', 'delivery', 'asset_rental') returning id`;
  const [pickup] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, code, capacity_model)
    values (${ORG}, 'Final pickup', 'pickup', 'asset_rental') returning id`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Haul Customer') returning id`;
  let n = 100;
  const stop = async (name: string, jobTypeId: string, lng: number, order: number) => {
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
      values (${ORG}, ${`${lng} Site`}, 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.30)}, ${geo.formatCoordinate(lng)}, 'rooftop', 'test')
      returning id`;
    const [job] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
      values (${ORG}, ${n++}, ${customer!.id}, ${p!.id}, ${jobTypeId}, 'scheduled', 'Haul') returning id`;
    const [v] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, status, window_start, window_end, route_order, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'dispatched', ${time.instantOfLocal(day, 8 * 60, ZONE)}, ${time.instantOfLocal(day, 17 * 60, ZONE)}, ${order}, 20)
      returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${driverId}, true)`;
    stops[name] = v!.id;
  };
  await stop("pickup", pickup!.id, -97.70, 1);
  await stop("drop", drop!.id, -97.69, 2);
  /** Nearest to the collection, a bigger drive to the second, a long way to the third. */
  await facility("Near Transfer", -97.695);
  await facility("Middle Landfill", -97.65);
  await facility("Far Landfill", -97.55);
});

afterAll(async () => { if (raw) await raw.end(); });

const optimise = (extra: { facilityId?: string } = {}) => dispatchMap.optimise(owner(), { date: day, technicianId: driverId, ...extra });
const only = (answer: Awaited<ReturnType<typeof optimise>>) => {
  expect(answer.truck!.facilityRuns).toHaveLength(1);
  return answer.truck!.facilityRuns[0]!;
};
const setHolidays = (name: string, holidays: rt.FacilityHoliday[]) =>
  facilities.updateFacility(owner(), { id: ids[name]!, holidays });

run("a day among several facilities", () => {
  it("sends the full container to the nearest facility by road, and says why", async () => {
    const answer = await optimise();
    const hop = only(answer);
    expect(hop).toMatchObject({
      afterVisitId: stops["pickup"], beforeVisitId: stops["drop"], tipped: 1, closed: null,
      facilityId: ids["Near Transfer"], facilityName: "Near Transfer",
    });
    expect(hop.driveMinutes).toBeGreaterThanOrEqual(0);
    expect(hop.why).toContain("Near Transfer is the nearest one open when the truck gets there");
    expect(hop.why).toContain("The others are farther.");
    expect(answer.truck!.facilities.map((f) => [f.name, f.onTheMap, f.closedToday])).toEqual([
      ["Far Landfill", true, null], ["Middle Landfill", true, null], ["Near Transfer", true, null],
    ]);
    // The first one a company records is its default, and the answer names the default.
    expect(answer.truck!.facility).toMatchObject({ id: ids["Near Transfer"], used: true });
    expect(answer.truck!.note).toContain("the nearest facility that is open");
    // The company's default is named, and wins nothing against a nearer one.
    await facilities.updateFacility(owner(), { id: ids["Far Landfill"]!, isDefault: true });
    const named = await optimise();
    expect(named.truck!.facility).toMatchObject({ id: ids["Far Landfill"], used: true });
    expect(only(named).facilityName).toBe("Near Transfer");
    expect(named.truck!.facility!.note).toContain("nearest of 3 facilities");
  });

  it("skips one that keeps a holiday that day, and says which and for what", async () => {
    await setHolidays("Near Transfer", [{ date: day, name: "Founders Day", yearly: false }]);
    const answer = await optimise();
    const hop = only(answer);
    expect(hop).toMatchObject({ facilityName: "Middle Landfill", closed: null });
    expect(hop.why).toContain("Middle Landfill is the nearest one open when the truck gets there");
    expect(hop.why).toContain("Near Transfer is closed for Founders Day.");
    expect(answer.truck!.facilities.find((f) => f.name === "Near Transfer")!.closedToday).toBe("closed for Founders Day");
  });

  it("keeps a yearly holiday on the same month and day of another year, and a holiday on another day is no matter", async () => {
    const lastYear = `${Number(day.slice(0, 4)) - 3}${day.slice(4)}`;
    await setHolidays("Near Transfer", [{ date: lastYear, name: "Founders Day", yearly: true }]);
    expect(only(await optimise()).facilityName).toBe("Middle Landfill");
    const elsewhere = time.addDays(day, 1);
    await setHolidays("Near Transfer", [{ date: elsewhere, name: "Another day", yearly: false }]);
    expect(only(await optimise()).facilityName).toBe("Near Transfer");
  });

  it("skips one whose week leaves the day out, and one the truck would reach after it closed", async () => {
    await setHolidays("Near Transfer", []);
    await facilities.updateFacility(owner(), { id: ids["Near Transfer"]!, hours: [{ day: (weekday + 1) % 7, opens: "07:00", closes: "16:00" }] });
    const shut = only(await optimise());
    expect(shut.facilityName).toBe("Middle Landfill");
    expect(shut.why).toContain("Near Transfer is closed on");

    await facilities.updateFacility(owner(), { id: ids["Near Transfer"]!, hours: [{ day: weekday, opens: "04:00", closes: "05:00" }] });
    const late = only(await optimise());
    expect(late.facilityName).toBe("Middle Landfill");
    expect(late.why).toContain("Near Transfer would be closed by then (it closes at 5:00 AM)");

    await facilities.updateFacility(owner(), { id: ids["Near Transfer"]!, hours: [] });
  });

  it("refuses the run in words when every facility is shut, naming the holiday", async () => {
    for (const name of ["Near Transfer", "Middle Landfill", "Far Landfill"]) {
      await setHolidays(name, [{ date: day, name: "Founders Day", yearly: false }]);
    }
    const answer = await optimise();
    const hop = only(answer);
    expect(hop.closed).toMatch(/is closed on \w+ \d{4}-\d{2}-\d{2} for Founders Day/);
    expect(hop.why).toContain("Every facility is shut when the truck would get there");
    expect(hop.facilityName).toBe("Near Transfer");
    for (const name of ["Near Transfer", "Middle Landfill", "Far Landfill"]) await setHolidays(name, []);
  });

  it("plans through only the facility asked for, even a farther one, and even a shut one", async () => {
    const asked = only(await optimise({ facilityId: ids["Far Landfill"]! }));
    expect(asked).toMatchObject({ facilityName: "Far Landfill" });
    expect(asked.why).toContain("only facility on the map");
    await setHolidays("Far Landfill", [{ date: day, name: "Founders Day", yearly: false }]);
    expect(only(await optimise({ facilityId: ids["Far Landfill"]! })).closed).toContain("Founders Day");
    await setHolidays("Far Landfill", []);
  });

  it("leaves out one that is not on the map, and says so, planning among the rest", async () => {
    await facilities.unpinFacility(owner(), { id: ids["Near Transfer"]! });
    const answer = await optimise();
    expect(only(answer).facilityName).toBe("Middle Landfill");
    expect(answer.truck!.facilities.find((f) => f.name === "Near Transfer")!.onTheMap).toBe(false);
    await facilities.pinFacility(owner(), { id: ids["Near Transfer"]!, latitude: 30.30, longitude: -97.695 });
  });
});

run("the holidays a facility keeps", () => {
  it("are saved with the facility, listed in date order, and refused in words when they are not dates", async () => {
    const saved = await facilities.updateFacility(owner(), {
      id: ids["Middle Landfill"]!,
      holidays: [
        { date: "2026-12-25", name: " Christmas ", yearly: true },
        { date: "2026-11-26", name: "Thanksgiving", yearly: false },
      ],
    });
    expect(saved.holidays).toEqual([
      { date: "2026-11-26", name: "Thanksgiving", yearly: false },
      { date: "2026-12-25", name: "Christmas", yearly: true },
    ]);
    // A change that does not mention holidays keeps them.
    expect((await facilities.updateFacility(owner(), { id: ids["Middle Landfill"]!, notes: "Scale on the left" })).holidays).toHaveLength(2);
    await expect(setHolidays("Middle Landfill", [{ date: "2026-02-31", name: null, yearly: false }])).rejects.toThrow(/2026-02-31 is not a date/);
    await expect(setHolidays("Middle Landfill", [
      { date: "2026-11-26", name: null, yearly: false }, { date: "2026-11-26", name: null, yearly: false },
    ])).rejects.toThrow(/listed twice/);
    expect((await facilities.listFacilities(owner())).facilities.find((f) => f.name === "Middle Landfill")!.holidays).toHaveLength(2);
  });

  it("make the facility shut for the open check, with the holiday in the sentence", async () => {
    const noon = time.instantOfLocal("2026-11-26", 12 * 60, ZONE).toISOString();
    const answer = await facilities.openAt(owner(), { id: ids["Middle Landfill"]!, at: noon });
    expect(answer.open).toBe(false);
    expect(answer.why).toContain("closed on Thursday 2026-11-26 for Thanksgiving");
    // The yearly one repeats.
    const next = time.instantOfLocal("2031-12-25", 12 * 60, ZONE).toISOString();
    expect((await facilities.openAt(owner(), { id: ids["Middle Landfill"]!, at: next })).why).toContain("for Christmas");
    // Another day, with no hours recorded, is open and says the hours are unknown.
    const other = time.instantOfLocal("2026-11-27", 12 * 60, ZONE).toISOString();
    expect(await facilities.openAt(owner(), { id: ids["Middle Landfill"]!, at: other })).toMatchObject({ open: true, hoursKnown: false });
  });
});
