import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as rules from "../src/services/task-rules";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * EVERY SO MANY WEEKS, ON SEVERAL DAYS, RAISED BY THE WORKER
 *
 * "Every third Monday and Thursday" is one template. Core's unit tests say
 * which days it is for; these say the service stores what core counts (one
 * day as the weekday it is, several as the days, never both), reads it back,
 * is changed between the two forms without keeping the old one, is refused
 * in the same words either way, and is raised by the worker on those days.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tsevdays:org");
const OWNER = fixtureId("tsevdays:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** Three in the afternoon in Chicago on a day, which is the same day in the company's calendar. */
const at = (day: string) => rules.raiseRecurringFor(db(), ORG, new Date(`${day}T20:00:00Z`));
const raisedDays = async (templateId: string) =>
  (await raw<{ d: string }[]>`select occurrence_on::text as d from public.task
    where template_id = ${templateId} order by occurrence_on`).map((r) => r.d);
const stored = async (id: string) => (await raw<{ weekday: number | null; days_of_week: number[] | null }[]>`
  select weekday, days_of_week from public.task_template where id = ${id}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Several Days Co", slug: "several-days-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
});

run("a recurring task counted in weeks, on several days", () => {
  it("raises every third week on Monday and Thursday, on those days and no others", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Dumpster swap", frequency: "every_n_weeks", daysOfWeek: [4, 1], intervalWeeks: 3, startsOn: "2026-10-05",
    });
    expect(template).toMatchObject({
      schedule: "Every 3 weeks on Monday and Thursday", weekday: null, daysOfWeek: [1, 4], intervalWeeks: 3,
    });
    for (const day of [
      "2026-10-05", "2026-10-06", "2026-10-08", "2026-10-12", "2026-10-19", "2026-10-26", "2026-10-27", "2026-10-29", "2026-11-02", "2026-11-16",
    ]) await at(day);
    expect(await raisedDays(template.id)).toEqual(["2026-10-05", "2026-10-08", "2026-10-26", "2026-10-29", "2026-11-16"]);
  });

  it("raises every other week on Tuesday and Saturday", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Van restock", frequency: "every_other_week", daysOfWeek: [2, 6], startsOn: "2026-10-05",
    });
    expect(template.schedule).toBe("Every other week on Tuesday and Saturday");
    for (const day of ["2026-10-06", "2026-10-10", "2026-10-13", "2026-10-17", "2026-10-20", "2026-10-24"]) await at(day);
    expect(await raisedDays(template.id)).toEqual(["2026-10-06", "2026-10-10", "2026-10-20", "2026-10-24"]);
  });

  it("stores one ticked day as the weekday it is, and several as the days, never both", async () => {
    const one = await rules.createTemplate(owner(), {
      title: "One day", frequency: "every_other_week", daysOfWeek: [3], startsOn: "2026-10-05",
    });
    expect(await stored(one.id)).toEqual({ weekday: 3, days_of_week: null });
    expect(one.schedule).toBe("Every other Wednesday");

    const several = await rules.createTemplate(owner(), {
      title: "Several", frequency: "every_other_week", weekday: 5, daysOfWeek: [3, 1, 3], startsOn: "2026-10-05",
    });
    expect(await stored(several.id)).toEqual({ weekday: null, days_of_week: [1, 3] });

    const plain = await rules.createTemplate(owner(), {
      title: "As before", frequency: "every_n_weeks", weekday: 2, intervalWeeks: 4, startsOn: "2026-10-05",
    });
    expect(await stored(plain.id)).toEqual({ weekday: 2, days_of_week: null });
  });

  it("is changed from one day to several, and back, without keeping the other form", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Round", frequency: "every_n_weeks", weekday: 1, intervalWeeks: 3, startsOn: "2026-10-05",
    });
    const several = await rules.updateTemplate(owner(), { id: template.id, daysOfWeek: [1, 4] });
    expect(several).toMatchObject({ weekday: null, daysOfWeek: [1, 4], schedule: "Every 3 weeks on Monday and Thursday" });

    const one = await rules.updateTemplate(owner(), { id: template.id, weekday: 4 });
    expect(one).toMatchObject({ weekday: 4, daysOfWeek: null, schedule: "Every 3 weeks on Thursday" });
    expect(await stored(template.id)).toEqual({ weekday: 4, days_of_week: null });

    /** Ticking exactly one day while a different weekday is stored takes the ticked one. */
    const ticked = await rules.updateTemplate(owner(), { id: template.id, daysOfWeek: [2] });
    expect(ticked).toMatchObject({ weekday: 2, daysOfWeek: null });
  });

  it("forgets the days when the schedule becomes a weekly or a monthly one", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Round", frequency: "every_n_weeks", daysOfWeek: [1, 4], intervalWeeks: 3, startsOn: "2026-10-05",
    });
    const weekly = await rules.updateTemplate(owner(), { id: template.id, frequency: "weekly", weekday: 2 });
    expect(await stored(template.id)).toEqual({ weekday: 2, days_of_week: null });
    expect(weekly.schedule).toBe("Every Tuesday");
  });

  it("is refused in plain words: no day, a bad day, two different ways of naming one day, no gap", async () => {
    const base = { title: "X", intervalWeeks: 3, startsOn: "2026-10-05" } as const;
    await expect(rules.createTemplate(owner(), { ...base, frequency: "every_n_weeks" }))
      .rejects.toThrow("A task every few weeks needs the day of the week it comes round on.");
    await expect(rules.createTemplate(owner(), { ...base, frequency: "every_n_weeks", daysOfWeek: [1, 9] as number[] }))
      .rejects.toThrow("A day of the week is 0 for Sunday to 6 for Saturday.");
    await expect(rules.createTemplate(owner(), { ...base, frequency: "every_n_weeks", weekday: 2, daysOfWeek: [4] }))
      .rejects.toThrow(/in one place/);
    await expect(rules.createTemplate(owner(), { title: "X", frequency: "every_n_weeks", daysOfWeek: [1, 4], startsOn: "2026-10-05" }))
      .rejects.toThrow(ConflictError);
  });
});
