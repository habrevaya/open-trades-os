import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as holidays from "../src/services/holidays";
import * as booking from "../src/services/booking";
import * as reviews from "../src/services/reviews";
import * as rules from "../src/services/task-rules";
import { hoursOf } from "../src/services/agent-facts";
import { daysFor } from "../src/services/dispatch-days";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE COMPANY'S HOLIDAYS, AND EVERYTHING THAT READS ITS HOURS
 *
 * One list, read the same way by every reader: online booking offers nothing
 * on a closed date and only what fits a short day, a booking for a date that
 * has since closed is refused, the reviews clock does not run, the phone
 * assistant is told, the multi day rebalance moves nothing onto it, and a
 * recurring task told to skip holidays raises nothing. The phones are proved
 * in the phone menu suite, by a call on a holiday.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("holidays:org");
const USER = fixtureId("holidays:user");
const SLUG = "holiday-co";
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let serviceId = "";
let morning = "";
let afternoon = "";

async function slotsOn(date: string) {
  const [service] = await inTenant(owner(), (tx) =>
    tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
  return booking.openSlots(db(), { organizationId: ORG, timezone: ZONE, service: service!, from: date, days: 1 });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Holiday Co", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  const [m] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week, sort_order)
    values (${ORG}, 'Morning', '08:00', '11:00', ${[0, 1, 2, 3, 4, 5, 6]}, 1) returning id`;
  const [a] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week, sort_order)
    values (${ORG}, 'Afternoon', '12:00', '16:00', ${[0, 1, 2, 3, 4, 5, 6]}, 2) returning id`;
  morning = m!.id;
  afternoon = a!.id;
  const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, default_duration_minutes)
    values (${ORG}, 'Service call', 60) returning id`;
  const [s] = await raw<{ id: string }[]>`insert into public.bookable_service (organization_id, job_type_id, public_name, max_per_window, min_notice_hours, max_advance_days)
    values (${ORG}, ${t!.id}, 'Service call', 5, 24, 60) returning id`;
  serviceId = s!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["company_holiday", "booking_request", "task", "task_template", "review", "review_policy"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("keeping the list", () => {
  it("adds a closed day and a short day, and reads them back in words, coming ones first", async () => {
    await holidays.create(owner(), { name: "Christmas Day", date: "2020-12-25", repeatsYearly: true, closed: true });
    await holidays.create(owner(), { name: "Old one", date: "2020-01-02", closed: true });
    await holidays.create(owner(), {
      name: "Christmas Eve", date: `${companyToday(0, ZONE).slice(0, 4)}-12-24`, closed: false, opensAt: "08:00", closesAt: "12:00",
    });
    const list = await holidays.list(owner());
    expect(list.map((h) => h.name)).toEqual(["Christmas Eve", "Christmas Day", "Old one"]);
    expect(list[0]).toMatchObject({ hours: "Open 08:00 to 12:00", opensAt: "08:00", closesAt: "12:00" });
    expect(list[1]).toMatchObject({ hours: "Closed", repeatsYearly: true });
    expect(list[1]!.nextOn!.slice(5)).toBe("12-25");
    expect(list[2]).toMatchObject({ nextOn: null });
  });

  it("refuses a second entry for the same date, in words, and lets a one off sit on a yearly day", async () => {
    await holidays.create(owner(), { name: "Christmas Day", date: "2020-12-25", repeatsYearly: true, closed: true });
    await expect(holidays.create(owner(), { name: "Xmas", date: "2024-12-25", repeatsYearly: true, closed: true }))
      .rejects.toThrow(/"Christmas Day" is already on the list every year/);
    await holidays.create(owner(), { name: "Open this year", date: "2026-12-25", closed: false, opensAt: "09:00", closesAt: "12:00" });
    await expect(holidays.create(owner(), { name: "Again", date: "2026-12-25", closed: true }))
      .rejects.toThrow(/"Open this year" is already on the list for 2026-12-25/);
  });

  it("refuses hours that close before they open, and a yearly 29th of February", async () => {
    await expect(holidays.create(owner(), { name: "Odd", date: "2026-07-03", closed: false, opensAt: "12:00", closesAt: "08:00" }))
      .rejects.toThrow(ConflictError);
    await expect(holidays.create(owner(), { name: "Leap", date: "2028-02-29", repeatsYearly: true, closed: true }))
      .rejects.toThrow(/29th of February/);
  });

  it("changes and removes one, and removing it again succeeds", async () => {
    const day = await holidays.create(owner(), { name: "Shop party", date: "2026-08-14", closed: true });
    const changed = await holidays.update(owner(), {
      id: day.id, name: "Shop party", date: "2026-08-14", closed: false, opensAt: "07:00", closesAt: "11:00",
    });
    expect(changed.hours).toBe("Open 07:00 to 11:00");
    expect(await holidays.remove(owner(), { id: day.id })).toEqual({ removed: true });
    expect(await holidays.remove(owner(), { id: day.id })).toEqual({ removed: false });
    const audits = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${day.id} order by created_at`;
    expect(audits.map((a) => a.action)).toEqual(["holiday.added", "holiday.changed", "holiday.removed"]);
  });

  it("is changed only by somebody who sets up the hours, and read by anybody who reads settings", async () => {
    await expect(holidays.create(as(["dispatcher"]), { name: "Nope", date: "2026-07-03", closed: true }))
      .rejects.toThrow(PermissionError);
    await holidays.create(owner(), { name: "Fourth", date: "2026-07-04", closed: true });
    expect(await holidays.list(as(["office_manager"]))).toHaveLength(1);
    await expect(holidays.list(as(["technician"]))).rejects.toThrow(PermissionError);
  });
});

run("online booking", () => {
  const DAY = companyToday(10, ZONE);

  it("offers no window on a closed day, and the next day as usual", async () => {
    expect((await slotsOn(DAY)).map((s) => s.arrivalWindowId)).toEqual([morning, afternoon]);
    await holidays.create(owner(), { name: "Closed", date: DAY, closed: true });
    expect(await slotsOn(DAY)).toEqual([]);
    expect(await slotsOn(companyToday(11, ZONE))).toHaveLength(2);
  });

  it("offers only the windows that fit inside a short day's hours", async () => {
    await holidays.create(owner(), { name: "Half day", date: DAY, closed: false, opensAt: "07:30", closesAt: "12:00" });
    expect((await slotsOn(DAY)).map((s) => s.arrivalWindowId)).toEqual([morning]);
  });

  it("refuses a booking for a date the company has since closed, as it refuses a full window", async () => {
    await holidays.create(owner(), { name: "Closed", date: DAY, closed: true });
    await expect(booking.createRequest(db(), {
      organizationSlug: SLUG, bookableServiceId: serviceId, requestedDate: DAY, arrivalWindowId: morning,
      contactName: "Pat Customer", contactPhone: "+15125550100", addressLine1: "1 Main St", city: "Austin", state: "TX",
      postalCode: "78701", intakeAnswers: {}, utm: {},
    })).rejects.toThrow(/We are closed on/);
    const rows = await raw`select 1 from public.booking_request where organization_id = ${ORG}`;
    expect(rows).toHaveLength(0);
  });
});

run("the reviews clock", () => {
  it("does not run on a closed holiday", async () => {
    await reviews.setPolicy(owner(), { timeZone: ZONE });
    // Posted Thursday 24 December 2026 at 16:00 Chicago: one open hour that day.
    await reviews.record(owner(), { platform: "google", rating: 1, postedAt: new Date("2026-12-24T22:00:00Z") });
    const before = (await reviews.workList(owner(), new Date("2026-12-24T22:30:00Z")))[0]!;
    // Without a holiday the other three hours are Friday morning.
    expect(new Date(before.dueAt).toISOString()).toBe("2026-12-25T17:00:00.000Z");

    await holidays.create(owner(), { name: "Christmas Day", date: "2020-12-25", repeatsYearly: true, closed: true });
    const after = (await reviews.workList(owner(), new Date("2026-12-24T22:30:00Z")))[0]!;
    // Christmas is shut and so is the weekend, so they are Monday morning.
    expect(new Date(after.dueAt).toISOString()).toBe("2026-12-28T17:00:00.000Z");
  });
});

run("the assistants", () => {
  it("are told about a holiday coming up", async () => {
    const date = companyToday(5, ZONE);
    await holidays.create(owner(), { name: "Shop moving day", date, closed: true });
    const hours = await inTenant(owner(), (tx) => hoursOf(tx, ORG));
    expect(hours).toContain(`Holiday ${date} (Shop moving day): closed`);
    expect(hours[0]).toBe("Sunday: 07:00 to 18:00");
  });
});

run("the multi day rebalance", () => {
  it("never offers a closed date as a day to move a visit to", () => {
    const visit = {
      locked: false, status: "scheduled", movable: null, preferredDays: [1, 2, 3, 4, 5],
    } as unknown as Parameters<typeof daysFor>[0];
    const range = ["2026-12-23", "2026-12-24", "2026-12-25", "2026-12-28"];
    const open = new Set([1, 2, 3, 4, 5]);
    expect(daysFor(visit, "2026-12-23", range, { today: "2026-12-22", open }).dates)
      .toEqual(["2026-12-24", "2026-12-25", "2026-12-28"]);
    expect(daysFor(visit, "2026-12-23", range, { today: "2026-12-22", open, closed: new Set(["2026-12-25"]) }).dates)
      .toEqual(["2026-12-24", "2026-12-28"]);
  });
});

run("recurring tasks", () => {
  it("raise nothing on a closed holiday when told to skip them, and do not raise it the day after instead", async () => {
    const skipping = await rules.createTemplate(owner(), {
      title: "Check the vans", frequency: "daily", startsOn: "2026-01-01", skipHolidays: true,
    });
    const plain = await rules.createTemplate(owner(), { title: "Answer the phones", frequency: "daily", startsOn: "2026-01-01" });
    expect(skipping.schedule).toBe("Every day, not on a holiday");
    await holidays.create(owner(), { name: "Christmas Day", date: "2020-12-25", repeatsYearly: true, closed: true });

    const christmas = await rules.raiseRecurringFor(db(), ORG, new Date("2026-12-25T15:00:00Z"));
    expect(christmas).toHaveLength(1);
    const raised = await raw<{ template_id: string }[]>`select template_id from public.task where organization_id = ${ORG}`;
    expect(raised.map((r) => r.template_id)).toEqual([plain.id]);

    const [skippedLine] = await raw<{ after: { occurrenceOn: string; holiday: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'task_template.skipped_holiday'`;
    expect(skippedLine!.after).toEqual({ occurrenceOn: "2026-12-25", holiday: "Christmas Day" });

    // The day after raises the day after's, once each, and nothing for Christmas.
    expect(await rules.raiseRecurringFor(db(), ORG, new Date("2026-12-26T15:00:00Z"))).toHaveLength(2);
    const days = await raw`select occurrence_on::text as d from public.task where template_id = ${skipping.id}`;
    expect(days.map((r) => r.d)).toEqual(["2026-12-26"]);
  });

  it("raise the task on a short day, which is a working day", async () => {
    await rules.createTemplate(owner(), { title: "Open up", frequency: "daily", startsOn: "2026-01-01", skipHolidays: true });
    await holidays.create(owner(), { name: "Christmas Eve", date: "2026-12-24", closed: false, opensAt: "08:00", closesAt: "12:00" });
    expect(await rules.raiseRecurringFor(db(), ORG, new Date("2026-12-24T15:00:00Z"))).toHaveLength(1);
  });
});
