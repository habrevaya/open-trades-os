import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { holidays as rules, time, type Actor } from "@opentradesos/core";
import * as businessHours from "../src/services/business-hours";
import * as dispatch from "../src/services/dispatch";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M02. A SEASON THAT CHANGES ONLY SATURDAYS, AND ONE FROM MEMORIAL DAY TO LABOR DAY
 *
 * Partial Season Co opens Monday to Friday, eight to five. For a few weeks it
 * opens Saturday mornings too, and keeps every other day as usual: the
 * season says Saturday and nothing else. Every year it keeps "Summer hours"
 * from the last Monday of May to the first Monday of September, worked out
 * for each year. Its Houston branch keeps a week of its own, so the company's
 * Saturday season does not reach it. A season that could share a day with
 * another of the same owner's in any year is refused, and only somebody who
 * configures booking keeps seasons.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("hours-season-days:org");
const USER = fixtureId("hours-season-days:user");
const ZONE = "America/Chicago";

/** A Saturday at least ten days out, and the Monday after it. */
const SAT = (() => {
  let day = companyToday(10, ZONE);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 6) day = time.addDays(day, 1);
  return day;
})();
const MON = time.addDays(SAT, 2);
const NEXT_YEAR = Number(companyToday(0, ZONE).slice(0, 4)) + 1;
const MEMORIAL = rules.weekdayOfMonth(NEXT_YEAR, { month: 5, weekday: 1, week: "last" });
const LABOR = rules.weekdayOfMonth(NEXT_YEAR, { month: 9, weekday: 1, week: 1 });

const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db() });
const owner = () => as("owner");
let houston = "";

const saturdays = (): businessHours.SeasonInput => ({
  name: "Saturday mornings", startsOn: time.addDays(SAT, -3), endsOn: time.addDays(SAT, 10), onlySomeDays: true,
  days: [{ dayOfWeek: 6, opensAt: "08:00", closesAt: "12:00", closed: false }],
});
const summer = (): businessHours.SeasonInput => ({
  name: "Summer hours", repeatsYearly: true,
  startsRule: { month: 5, weekday: 1, week: "last" }, endsRule: { month: 9, weekday: 1, week: 1 },
  days: week([1, 2, 3, 4, 5], "07:00", "15:00"),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Partial Season Co", slug: "hours-season-days-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "17:00") });
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  houston = h!.id;
  await businessHours.setWeek(owner(), { days: week([2, 3, 4, 5, 6], "07:00", "12:00"), businessUnitId: houston });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.business_hours_season where organization_id = ${ORG}`;
});

run("a season that changes only some days", () => {
  it("opens the day it changes and leaves every other day to the normal week", async () => {
    const added = await businessHours.addSeason(owner(), saturdays());
    expect(added).toMatchObject({ onlySomeDays: true, days: [{ dayOfWeek: 6, opensAt: "08:00", closesAt: "12:00" }] });

    const saturday = await dispatch.board(owner(), { date: SAT });
    expect(saturday.hours.words).toBe("Open 8:00 AM to 12:00 PM, Saturday mornings.");
    const monday = await dispatch.board(owner(), { date: MON });
    expect(monday.hours.words).toBe("Open 8:00 AM to 5:00 PM.");
    /** The Sunday between is still the normal week's: closed, and not "in Saturday mornings". */
    expect((await dispatch.board(owner(), { date: time.addDays(SAT, 1) })).hours.words).toBe("Closed on Sundays.");

    /** Online booking reads the same: Saturday is open while the season is in force. */
    const chosen = await businessHours.loadWeek(db(), ORG, null);
    expect(rules.openWeekdays(rules.weekOn(chosen, SAT).week)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(rules.openWeekdays(rules.weekOn(chosen, time.addDays(SAT, 21)).week)).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("does not reach a branch that keeps a week of its own", async () => {
    await businessHours.addSeason(owner(), { ...saturdays(), days: [{ dayOfWeek: 6, opensAt: "06:00", closesAt: "09:00", closed: false }] });
    const board = await dispatch.board(owner(), { date: SAT, businessUnitId: houston });
    expect(board.hours.words).toBe("Open 7:00 AM to 12:00 PM.");
  });

  it("is refused without a day to change, and with a day given twice", async () => {
    await expect(businessHours.addSeason(owner(), { ...saturdays(), days: [] }))
      .rejects.toThrow("Choose at least one day for the season to change.");
    const day = saturdays().days[0]!;
    await expect(businessHours.addSeason(owner(), { ...saturdays(), days: [day, day] }))
      .rejects.toThrow("A day is given twice. Give each day once.");
    /** A whole week still needs all seven days. */
    await expect(businessHours.addSeason(owner(), { ...saturdays(), onlySomeDays: false }))
      .rejects.toThrow("Send all seven days.");
  });
});

run("a yearly season on a day of the week in a month", () => {
  it("runs from the last Monday of May to the first Monday of September, worked out for each year", async () => {
    const added = await businessHours.addSeason(owner(), summer());
    expect(added.when).toBe("Last Monday of May to the first Monday of September, every year");
    expect(added.startsRule).toEqual({ month: 5, weekday: 1, week: "last" });
    expect(added.endsOn > added.startsOn).toBe(true);

    expect((await dispatch.board(owner(), { date: MEMORIAL })).hours.words).toBe("Open 7:00 AM to 3:00 PM, Summer hours.");
    expect((await dispatch.board(owner(), { date: LABOR })).hours.words).toBe("Open 7:00 AM to 3:00 PM, Summer hours.");
    expect((await dispatch.board(owner(), { date: time.addDays(MEMORIAL, -7) })).hours.words).toBe("Open 8:00 AM to 5:00 PM.");
    expect((await dispatch.board(owner(), { date: time.addDays(LABOR, 1) })).hours.words).toBe("Open 8:00 AM to 5:00 PM.");

    const listed = (await businessHours.listSeasons(owner())).seasons.find((s) => s.id === added.id)!;
    expect(listed).toMatchObject({ repeatsYearly: true, endsRule: { month: 9, weekday: 1, week: 1 }, onlySomeDays: false });
    const [line] = await raw<{ action: string }[]>`select action from public.audit_log
      where organization_id = ${ORG} and entity_id = ${added.id} order by created_at desc limit 1`;
    expect(line!.action).toBe("booking.season.added");
  });

  it("is refused when it does not come back every year, or could share a day with another in any year", async () => {
    await expect(businessHours.addSeason(owner(), { ...summer(), repeatsYearly: false }))
      .rejects.toThrow("A season on a day of the week in a month comes back every year.");
    await businessHours.addSeason(owner(), summer());
    /** The last Monday of May is the 25th at the earliest, so a season on May 24 can never meet it, and one on the 25th can. */
    await expect(businessHours.addSeason(owner(), {
      name: "Spring push", startsOn: `${NEXT_YEAR + 3}-05-25`, endsOn: `${NEXT_YEAR + 3}-05-25`, days: week([1, 2, 3, 4, 5, 6], "07:00", "18:00"),
    })).rejects.toThrow("which overlaps \"Summer hours\"");
    await expect(businessHours.addSeason(owner(), {
      name: "Spring push", startsOn: `${NEXT_YEAR + 3}-05-24`, endsOn: `${NEXT_YEAR + 3}-05-24`, days: week([1, 2, 3, 4, 5, 6], "07:00", "18:00"),
    })).resolves.toMatchObject({ name: "Spring push" });
  });

  it("is kept only by somebody who configures booking", async () => {
    await expect(businessHours.addSeason(as("dispatcher"), summer())).rejects.toThrow();
    await expect(businessHours.addSeason(as("technician"), saturdays())).rejects.toThrow();
    expect((await businessHours.listSeasons(owner())).seasons).toEqual([]);
  });
});
