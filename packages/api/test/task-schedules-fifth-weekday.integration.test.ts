import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as rules from "../src/services/task-rules";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE FIFTH GIVEN WEEKDAY OF A MONTH, AND A GAP OF MORE THAN A YEAR
 *
 * A fifth Monday is raised in the months that have five Mondays and in no
 * others: 2026's are March 30, June 29, August 31 and November 30, and a month
 * without one is skipped and said so. An every few weeks task can be as far
 * apart as five years.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tfifth:org");
const OWNER = fixtureId("tfifth:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
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
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Fifth Weekday Co", slug: "fifth-weekday-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`delete from public.task_template where organization_id = ${ORG}`;
});

run("the fifth given weekday of the month", () => {
  it("is raised in the months that have one, and the others are skipped", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Quarter end stock count", frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 5, startsOn: "2026-02-01",
    });
    expect(template).toMatchObject({
      monthWeek: 5, weekday: 1,
      schedule: "On the fifth Monday of the month, and a month without a fifth Monday is skipped",
    });
    for (const day of ["2026-02-23", "2026-03-02", "2026-03-30", "2026-04-27", "2026-05-25", "2026-06-29", "2026-08-31", "2026-10-26", "2026-11-30"]) {
      await at(day);
    }
    expect(await raisedDays(template.id)).toEqual(["2026-03-30", "2026-06-29", "2026-08-31", "2026-11-30"]);
  });

  it("shows the next one that exists, past the months without", async () => {
    await rules.createTemplate(owner(), {
      title: "Fifth Monday", frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 5, startsOn: "2026-10-01",
    });
    const [listed] = await rules.listTemplates(owner());
    expect(listed!.nextOn).toBe("2026-11-30");
  });

  it("is refused above the fifth, in words", async () => {
    await expect(rules.createTemplate(owner(), { title: "X", frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 6 }))
      .rejects.toThrow(/first, second, third, fourth or fifth/);
  });

  it("can be changed to from a fourth, applying from the next occurrence", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Count", frequency: "nth_weekday_of_month", weekday: 1, monthWeek: 4, startsOn: "2026-10-01",
    });
    await at("2026-10-26");
    const changed = await rules.updateTemplate(owner(), { id: template.id, monthWeek: 5 });
    expect(changed).toMatchObject({ monthWeek: 5, nextOn: "2026-11-30" });
    await at("2026-11-23");
    await at("2026-11-30");
    expect(await raisedDays(template.id)).toEqual(["2026-10-26", "2026-11-30"]);
  });
});

run("a gap of more than a year", () => {
  it("is stored, said in words and raised on the day", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Two yearly service", frequency: "every_n_weeks", weekday: 1, intervalWeeks: 104, startsOn: "2026-10-05",
    });
    expect(template).toMatchObject({ intervalWeeks: 104, schedule: "Every 104 weeks on Monday" });
    await at("2026-10-05");
    await at("2027-10-04");
    await at("2028-10-02");
    expect(await raisedDays(template.id)).toEqual(["2026-10-05", "2028-10-02"]);
  });

  it("goes up to five years and no further", async () => {
    await rules.createTemplate(owner(), { title: "Five yearly", frequency: "every_n_weeks", weekday: 1, intervalWeeks: 260 });
    await expect(rules.createTemplate(owner(), { title: "Too far", frequency: "every_n_weeks", weekday: 1, intervalWeeks: 261 }))
      .rejects.toThrow(/from 2 to 260/);
  });
});
