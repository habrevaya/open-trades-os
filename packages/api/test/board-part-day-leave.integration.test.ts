import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as dispatch from "../src/services/dispatch";
import * as timeOff from "../src/services/time-off";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M17. PART OF A DAY OFF, ON THE BOARD AS IN BOOKING.
 *
 * Time off is any two instants, so a run can begin part way through its first
 * day and end part way through its last. The board reads it the way booking
 * does: off for those hours, and nothing else on that day.
 *
 * Central time, October 2026 (UTC-5). 1 PM is 18:00Z, noon is 17:00Z.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("m17part:org");
const USER = fixtureId("m17part:user");
const TZ = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db() });
const owner = () => as(["owner"]);

let ray = "";
let customerId = "";
let propertyId = "";
let jobId = "";

/** A date in the future so booking checks them, in the company's zone. */
const days = (() => {
  const base = time.addDays(time.dateIn(new Date(), TZ), 20);
  return { mon: base, tue: time.addDays(base, 1), wed: time.addDays(base, 2) };
})();
const at = (date: string, hour: number, minute = 0) => time.instantOfLocal(date, hour * 60 + minute, TZ);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Part Day Co", slug: "part-day-co" });
  await raw`update public.organization set timezone = ${TZ} where id = ${ORG}`;
  const [m] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} limit 1`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, 'Ray Nunez') returning id`;
  ray = t!.id;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Pat Gray", phone: "+15125550194", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "5 Elm Ct", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
  const job = await jobs.create(owner(), { customerId, propertyId, summary: "Service call", tags: [], customFields: {} });
  jobId = job.id;
  /** From 1 PM Monday to noon Wednesday, approved: all of Tuesday in between. */
  const leave = await timeOff.request(owner(), {
    technicianId: ray, startsAt: at(days.mon, 13).toISOString(), endsAt: at(days.wed, 12).toISOString(), reason: "Family trip",
  });
  await timeOff.approve(owner(), { id: leave.id });
});

afterAll(async () => { if (raw) await raw.end(); });

const day = async (date: string) => (await dispatch.board(owner(), { date })).technicians.find((t) => t.id === ray)!;
const hours = (t: Awaited<ReturnType<typeof day>>) => t.timeOffHours.map((h) => [h.startsAt, h.endsAt]);
const book = (date: string, hour: number) => jobs.addVisit(owner(), {
  id: jobId, windowStart: at(date, hour).toISOString(), windowEnd: at(date, hour + 1).toISOString(),
  estimatedDurationMinutes: 60, technicianIds: [ray],
});

run("a run of days off that begins and ends part way through", () => {
  it("is off from one o'clock on the first day, for the hours it covers and no others", async () => {
    const first = await day(days.mon);
    expect(first).toMatchObject({ timeOff: true, timeOffWholeDay: false });
    expect(hours(first)).toEqual([[at(days.mon, 13).toISOString(), at(days.tue, 0).toISOString()]]);
  });

  it("is off all of the days in between", async () => {
    expect(await day(days.tue)).toMatchObject({ timeOff: true, timeOffWholeDay: true, timeOffHours: [] });
  });

  it("is off until noon on the last day, and back after", async () => {
    const last = await day(days.wed);
    expect(last).toMatchObject({ timeOff: true, timeOffWholeDay: false });
    expect(hours(last)).toEqual([[at(days.wed, 0).toISOString(), at(days.wed, 12).toISOString()]]);
  });

  it("is not off on a day it only touches, or one it does not reach", async () => {
    const before = await day(time.addDays(days.mon, -1));
    expect(before).toMatchObject({ timeOff: false, timeOffWholeDay: false, timeOffHours: [] });
    /** Leave that ends the instant a day begins is not on that day. */
    const after = await day(time.addDays(days.wed, 1));
    expect(after).toMatchObject({ timeOff: false, timeOffHours: [] });
  });

  it("joins a lunch hour with the leave it runs into, and keeps separate hours separate", async () => {
    const extra = await timeOff.request(owner(), {
      technicianId: ray, startsAt: at(days.mon, 8).toISOString(), endsAt: at(days.mon, 9).toISOString(),
    });
    await timeOff.approve(owner(), { id: extra.id });
    const first = await day(days.mon);
    expect(hours(first)).toEqual([
      [at(days.mon, 8).toISOString(), at(days.mon, 9).toISOString()],
      [at(days.mon, 13).toISOString(), at(days.tue, 0).toISOString()],
    ]);
    /** A request nobody has approved changes nothing. */
    await timeOff.request(owner(), {
      technicianId: ray, startsAt: at(days.mon, 10).toISOString(), endsAt: at(days.mon, 11).toISOString(),
    });
    expect(hours(await day(days.mon))).toHaveLength(2);
  });

  it("is the same answer booking gives: free in the morning of the first day, refused after one, refused in between, free after noon on the last", async () => {
    await expect(book(days.mon, 10)).resolves.toBeDefined();
    await expect(book(days.mon, 14)).rejects.toThrow(/on approved time off then/);
    await expect(book(days.tue, 10)).rejects.toThrow(/on approved time off then/);
    await expect(book(days.wed, 10)).rejects.toThrow(/on approved time off then/);
    await expect(book(days.wed, 14)).resolves.toBeDefined();
  });
});
