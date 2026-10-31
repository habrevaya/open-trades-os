import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as rules from "../src/services/task-rules";
import * as holidays from "../src/services/holidays";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A TASK ONCE A YEAR, ON A MONTH AND A DAY
 *
 * Renew the contractor licence every March 1. Raised on the day in the
 * company's calendar, once, never made up for a year that was missed, skipped
 * on a closed holiday like every other template, and the 29th of February is
 * raised on the 28th in a year that has no 29th.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tyearly:org");
const OWNER = fixtureId("tyearly:owner");
const TECH = fixtureId("tyearly:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const tech = () => as(TECH, ["technician"]);
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
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Yearly Co", slug: "yearly-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`delete from public.task_template where organization_id = ${ORG}`;
  await raw`delete from public."user" where id = ${TECH}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tech@yearly-co.test', 'Sam Tech')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH}, 'technician'::member_role)`;
});

run("a yearly recurring task", () => {
  it("is raised on its month and day each year, once, and says so in words", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Renew the contractor licence", frequency: "yearly", yearMonth: 3, monthDay: 1, startsOn: "2026-10-01",
    });
    expect(template).toMatchObject({
      frequency: "yearly", yearMonth: 3, monthDay: 1, weekday: null, nextOn: "2027-03-01",
      schedule: "Every year on March 1",
    });
    for (const day of ["2026-11-15", "2027-02-28", "2027-03-01", "2027-03-01", "2027-03-02", "2027-12-31", "2028-03-01"]) {
      await at(day);
    }
    expect(await raisedDays(template.id)).toEqual(["2027-03-01", "2028-03-01"]);
    const [listed] = await rules.listTemplates(owner());
    expect(listed).toMatchObject({ lastRaisedOn: "2028-03-01" });
  });

  it("raises the latest one only after the worker was down for years, and nothing before it starts", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Insurance renewal", frequency: "yearly", yearMonth: 6, monthDay: 15, startsOn: "2026-10-01",
    });
    expect(await at("2027-02-01")).toEqual([]);
    await at("2029-08-01");
    expect(await raisedDays(template.id)).toEqual(["2029-06-15"]);
  });

  it("skips a closed holiday and does not raise it the day after, then raises the next year", async () => {
    await holidays.create(owner(), { name: "Office closed", date: "2027-03-01", closed: true });
    const template = await rules.createTemplate(owner(), {
      title: "Renew the licence", frequency: "yearly", yearMonth: 3, monthDay: 1, startsOn: "2026-10-01", skipHolidays: true,
    });
    expect(template.schedule).toBe("Every year on March 1, not on a holiday");
    await at("2027-03-01");
    await at("2027-03-02");
    await at("2028-03-01");
    expect(await raisedDays(template.id)).toEqual(["2028-03-01"]);
    const [skipped] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'task_template.skipped_holiday'`;
    expect(skipped!.n).toBe(1);
  });

  it("puts February 29 on February 28 in a year without one, and says so", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Leap day check", frequency: "yearly", yearMonth: 2, monthDay: 29, startsOn: "2026-10-01",
    });
    expect(template.schedule)
      .toBe("Every year on February 29, or on February 28 in a year without a February 29");
    expect(template.nextOn).toBe("2027-02-28");
    for (const day of ["2027-02-27", "2027-02-28", "2028-02-28", "2028-02-29", "2029-02-27", "2029-02-28"]) await at(day);
    expect(await raisedDays(template.id)).toEqual(["2027-02-28", "2028-02-29", "2029-02-28"]);
  });

  it("is refused without a month or a day, or on a day the month does not have, in words", async () => {
    const base = { title: "X", frequency: "yearly" as const };
    await expect(rules.createTemplate(owner(), { ...base, monthDay: 1 })).rejects.toThrow(/month it comes round in/);
    await expect(rules.createTemplate(owner(), { ...base, yearMonth: 3 })).rejects.toThrow(/day of the month it comes round on/);
    await expect(rules.createTemplate(owner(), { ...base, yearMonth: 4, monthDay: 31 })).rejects.toThrow(/April has no day 31/);
    await expect(rules.createTemplate(owner(), { ...base, yearMonth: 2, monthDay: 30 })).rejects.toThrow(/February has no day 30/);
    await expect(rules.createTemplate(owner(), { ...base, yearMonth: 13, monthDay: 1 })).rejects.toThrow();
  });

  it("keeps only what its schedule reads when changed to and from yearly", async () => {
    const weekly = await rules.createTemplate(owner(), { title: "Check", frequency: "weekly", weekday: 2, startsOn: "2026-10-01" });
    const yearly = await rules.updateTemplate(owner(), { id: weekly.id, frequency: "yearly", yearMonth: 9, monthDay: 30 });
    expect(yearly).toMatchObject({ frequency: "yearly", weekday: null, yearMonth: 9, monthDay: 30 });
    const monthly = await rules.updateTemplate(owner(), { id: weekly.id, frequency: "monthly", monthDay: 12 });
    expect(monthly).toMatchObject({ frequency: "monthly", yearMonth: null, monthDay: 12 });
    const [audited] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'task_template.updated' and entity_id = ${weekly.id}`;
    expect(audited!.n).toBe(2);
  });

  it("does not raise a date that has already gone by this year just because it was changed to", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Renew", frequency: "yearly", yearMonth: 1, monthDay: 1, startsOn: companyToday(-400),
    });
    const past = companyToday(-10);
    await rules.updateTemplate(owner(), { id: template.id, yearMonth: Number(past.slice(5, 7)), monthDay: Number(past.slice(8, 10)) });
    expect(await rules.raiseRecurringFor(db(), ORG)).toEqual([]);
    expect(await raisedDays(template.id)).toEqual([]);

    // Changed to today's date, it is raised today.
    const today = companyToday();
    await rules.updateTemplate(owner(), { id: template.id, yearMonth: Number(today.slice(5, 7)), monthDay: Number(today.slice(8, 10)) });
    expect(await rules.raiseRecurringFor(db(), ORG)).toHaveLength(1);
    expect(await raisedDays(template.id)).toEqual([today]);
  });

  it("is added and changed with the task permission, not the read one", async () => {
    await expect(rules.createTemplate(tech(), { title: "X", frequency: "yearly", yearMonth: 3, monthDay: 1 }))
      .rejects.toThrow(/task:write|permission|allowed/i);
  });
});
