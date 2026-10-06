import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as rules from "../src/services/task-rules";
import * as holidays from "../src/services/holidays";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE THREE NEWER SCHEDULES, RAISED BY THE WORKER
 *
 * The first Monday of the month, every third week and the days a crew
 * works are counted by core, and core's unit tests say which day each one
 * is for. These say the service stores what core counts, the worker raises
 * on those days and no others, and "not on a holiday" can be switched on an
 * existing template and is honoured from the next occurrence.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tsched:org");
const OWNER = fixtureId("tsched:owner");
const TECH = fixtureId("tsched:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const tech = () => as(TECH, ["technician"]);

/** Three in the afternoon in Chicago on a day, which is the same day in the company's calendar. */
const at = (day: string) => rules.raiseRecurringFor(db(), ORG, new Date(`${day}T20:00:00Z`));
const raisedDays = async (templateId: string) =>
  (await raw<{ d: string }[]>`select occurrence_on::text as d from public.task
    where template_id = ${templateId} order by occurrence_on`).map((r) => r.d);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Schedule Co", slug: "schedule-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`delete from public."user" where id = ${TECH}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tech@schedule-co.test', 'Sam Tech')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH}, 'technician'::member_role)`;
});

run("the newer recurring schedules", () => {
  it("raises the first Monday of the month on that day and no other", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Fire extinguisher check", frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 1, startsOn: "2026-10-01",
    });
    expect(template).toMatchObject({
      schedule: "On the first Monday of every month", monthWeek: 1, weekday: 1,
    });
    expect(await at("2026-10-05")).toHaveLength(1);
    expect(await at("2026-10-12")).toEqual([]);
    expect(await at("2026-10-31")).toEqual([]);
    expect(await at("2026-11-02")).toHaveLength(1);
    expect(await raisedDays(template.id)).toEqual(["2026-10-05", "2026-11-02"]);
  });

  it("raises every third week counted from the first such weekday on or after the start", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Filter round", frequency: "every_n_weeks", weekday: 3, intervalWeeks: 3, startsOn: "2026-10-05",
    });
    expect(template).toMatchObject({ schedule: "Every 3 weeks on Wednesday", intervalWeeks: 3 });
    for (const day of ["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04", "2026-11-18"]) await at(day);
    expect(await raisedDays(template.id)).toEqual(["2026-10-07", "2026-10-28", "2026-11-18"]);
  });

  it("raises on the ticked days only, and stores them once each in order", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Yard sweep", frequency: "chosen_weekdays", daysOfWeek: [6, 1, 3, 1], startsOn: "2026-10-05",
    });
    expect(template).toMatchObject({ daysOfWeek: [1, 3, 6], schedule: "Every Monday, Wednesday and Saturday" });
    for (let d = 5; d <= 11; d += 1) await at(`2026-10-${String(d).padStart(2, "0")}`);
    expect(await raisedDays(template.id)).toEqual(["2026-10-05", "2026-10-07", "2026-10-10"]);
  });

  it("refuses each new schedule without what it needs, in words", async () => {
    await expect(rules.createTemplate(owner(), { title: "X", frequency: "nth_weekday_of_month", weekday: 1 }))
      .rejects.toThrow(/first, second, third or fourth/);
    await expect(rules.createTemplate(owner(), { title: "X", frequency: "every_n_weeks", weekday: 1, intervalWeeks: 1 }))
      .rejects.toThrow(/every how many weeks/);
    await expect(rules.createTemplate(owner(), { title: "X", frequency: "chosen_weekdays", daysOfWeek: [] }))
      .rejects.toThrow(/at least one day/);
    await expect(rules.createTemplate(tech(), { title: "X", frequency: "chosen_weekdays", daysOfWeek: [1] }))
      .rejects.toThrow(PermissionError);
  });

  it("keeps only the settings the schedule reads when it is changed", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Crew days", frequency: "chosen_weekdays", daysOfWeek: [1, 2],
    });
    const changed = await rules.updateTemplate(owner(), {
      id: template.id, frequency: "nth_weekday_of_month", weekday: 5, monthWeek: 2,
    });
    expect(changed).toMatchObject({
      daysOfWeek: null, monthWeek: 2, weekday: 5, schedule: "On the second Friday of every month",
    });
    const again = await rules.updateTemplate(owner(), { id: template.id, frequency: "daily" });
    expect(again).toMatchObject({ monthWeek: null, weekday: null, intervalWeeks: null, daysOfWeek: null });
  });
});

run("switching holidays on an existing template", () => {
  it("skips a closed holiday once switched on, and raises on it again once switched off", async () => {
    await holidays.create(owner(), { name: "Founders day", date: "2026-10-07", closed: true });
    const template = await rules.createTemplate(owner(), {
      title: "Open up", frequency: "chosen_weekdays", daysOfWeek: [1, 3, 5], startsOn: "2026-10-01",
    });
    expect(template.skipHolidays).toBe(false);

    const on = await rules.updateTemplate(owner(), { id: template.id, skipHolidays: true });
    expect(on).toMatchObject({ skipHolidays: true, schedule: "Every Monday, Wednesday and Friday, not on a holiday" });
    expect(await at("2026-10-05")).toHaveLength(1);
    expect(await at("2026-10-07")).toEqual([]);
    const [skipped] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'task_template.skipped_holiday'`;
    expect(skipped!.n).toBe(1);

    // Switched off, the next closed holiday is raised as an ordinary day. The
    // one already skipped stays skipped: it is not raised the day after.
    await holidays.create(owner(), { name: "Staff day", date: "2026-10-09", closed: true });
    const off = await rules.updateTemplate(owner(), { id: template.id, skipHolidays: false });
    expect(off.schedule).toBe("Every Monday, Wednesday and Friday");
    expect(await at("2026-10-08")).toEqual([]);
    expect(await at("2026-10-09")).toHaveLength(1);
    expect(await raisedDays(template.id)).toEqual(["2026-10-05", "2026-10-09"]);
  });
});
