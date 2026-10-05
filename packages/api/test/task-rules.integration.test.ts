import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as tasks from "../src/services/tasks";
import * as checklist from "../src/services/task-checklist";
import * as rules from "../src/services/task-rules";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE QUEUE WORKING WHEN NOBODY IS LOOKING AT IT
 *
 * Recurring tasks and escalation both run from the worker, and both promise
 * "once": one task per template per day, one notice per task per rule. Those
 * promises are kept by unique indexes, so they are checked here by running
 * the worker's own functions twice and counting rows.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("trule:org");
const OWNER = fixtureId("trule:owner");
const MANAGER = fixtureId("trule:manager");
const TECH = fixtureId("trule:tech");
const CSR = fixtureId("trule:csr");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const tech = () => as(TECH, ["technician"]);

const HOUR = 3_600_000;

async function member(id: string, email: string, role: string, name: string) {
  await raw`delete from public."user" where id = ${id}`;
  await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role)`;
}

const tasksFor = (userId: string) => raw<{ title: string; entity_id: string | null }[]>`
  select title, entity_id from public.task where organization_id = ${ORG} and assignee_user_id = ${userId}
  order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Rule Co", slug: "rule-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await member(MANAGER, "manager@rule-co.test", "office_manager", "Mona Manager");
  await member(TECH, "tech@rule-co.test", "technician", "Sam Tech");
  await member(CSR, "csr@rule-co.test", "csr", "Cass Csr");
});

run("a checklist inside a task", () => {
  it("closes as done only when ticked, or with a reason kept apart from the outcome", async () => {
    const task = await tasks.create(owner(), { title: "Open the shop", checklist: ["Alarm off", "Lights on"] });
    const list = await checklist.list(owner(), { taskId: task.id });
    expect(list.items.map((i) => i.label)).toEqual(["Alarm off", "Lights on"]);

    await checklist.tick(owner(), { taskId: task.id, itemId: list.items[0]!.id, done: true });
    await expect(tasks.close(owner(), { id: task.id })).rejects.toThrow(/One item is not ticked/);

    const closed = await tasks.close(owner(), { id: task.id, outcome: "Opened", overrideReason: "Bulb gone" });
    expect(closed).toMatchObject({ status: "done", outcome: "Opened", checklistOverrideReason: "Bulb gone" });
  });

  it("dismisses without asking about the checklist", async () => {
    const task = await tasks.create(owner(), { title: "Van check", checklist: ["Tyres"] });
    await expect(tasks.close(owner(), { id: task.id, dismissed: true, outcome: "Van in the shop" }))
      .resolves.toMatchObject({ status: "dismissed", checklistOverrideReason: null });
  });

  it("lets the assignee tick their own items with task:read, and nobody else without task:write", async () => {
    const task = await tasks.create(owner(), { title: "Van check", assigneeUserId: TECH, checklist: ["Tyres"] });
    const [item] = (await checklist.list(owner(), { taskId: task.id })).items;
    const ticked = await checklist.tick(tech(), { taskId: task.id, itemId: item!.id, done: true });
    expect(ticked).toMatchObject({ done: true, doneBy: "Sam Tech" });
    // Ticking again is where the first call left it.
    await checklist.tick(tech(), { taskId: task.id, itemId: item!.id, done: true });

    const other = await tasks.create(owner(), { title: "Not theirs", checklist: ["Thing"] });
    const [otherItem] = (await checklist.list(owner(), { taskId: other.id })).items;
    await expect(checklist.tick(tech(), { taskId: other.id, itemId: otherItem!.id, done: true }))
      .rejects.toThrow(PermissionError);
  });

  it("adds and removes items, and refuses changes once closed", async () => {
    const task = await tasks.create(owner(), { title: "Close up" });
    const added = await checklist.add(owner(), { taskId: task.id, label: "Lock the yard" });
    await checklist.add(owner(), { taskId: task.id, label: "Set the alarm" });
    await checklist.remove(owner(), { taskId: task.id, itemId: added.id });
    await checklist.remove(owner(), { taskId: task.id, itemId: added.id });
    expect((await checklist.list(owner(), { taskId: task.id })).items.map((i) => i.label)).toEqual(["Set the alarm"]);

    await tasks.close(owner(), { id: task.id, overrideReason: "Alarm broken" });
    await expect(checklist.add(owner(), { taskId: task.id, label: "Late" })).rejects.toThrow(ConflictError);
  });

  it("counts the checklist on the queue", async () => {
    const task = await tasks.create(owner(), { title: "Counted", checklist: ["a", "b", "c"] });
    const [item] = (await checklist.list(owner(), { taskId: task.id })).items;
    await checklist.tick(owner(), { taskId: task.id, itemId: item!.id, done: true });
    const row = (await tasks.list(owner(), { view: "all" })).data.find((t) => t.id === task.id);
    expect(row).toMatchObject({ checklistTotal: 3, checklistDone: 1 });
  });
});

run("recurring tasks", () => {
  it("raises one task for the company's day, whatever the worker does", async () => {
    await rules.createTemplate(owner(), {
      title: "Check the vans", frequency: "weekly", weekday: 1, dueMinutes: 9 * 60,
      checklist: ["Tyres", "Oil"], assigneeUserId: TECH, startsOn: "2026-01-01",
    });
    // Monday 5 October 2026, 08:00 in Chicago.
    const monday = new Date("2026-10-05T13:00:00Z");
    const first = await rules.raiseRecurringFor(db(), ORG, monday);
    const again = await rules.raiseRecurringFor(db(), ORG, monday);
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);

    const [task] = await raw`select title, occurrence_on, due_at, assignee_user_id from public.task
      where organization_id = ${ORG} and template_id is not null`;
    expect(task!.title).toBe("Check the vans");
    expect(task!.assignee_user_id).toBe(TECH);
    // Due at nine in Chicago, which is 14:00 UTC in October.
    expect((task!.due_at as Date).toISOString()).toBe("2026-10-05T14:00:00.000Z");
    const items = await raw`select label from public.task_checklist_item where task_id = (
      select id from public.task where organization_id = ${ORG} and template_id is not null) order by position`;
    expect(items.map((i) => i.label)).toEqual(["Tyres", "Oil"]);
  });

  it("does not raise Monday's task on Sunday evening in Chicago", async () => {
    await rules.createTemplate(owner(), { title: "Weekly", frequency: "weekly", weekday: 1, startsOn: "2026-10-05" });
    // 02:00 UTC on Monday is still Sunday evening in Chicago.
    expect(await rules.raiseRecurringFor(db(), ORG, new Date("2026-10-05T02:00:00Z"))).toEqual([]);
    expect(await rules.raiseRecurringFor(db(), ORG, new Date("2026-10-05T06:00:00Z"))).toHaveLength(1);
  });

  it("survives a stale bookkeeping date, because the index decides", async () => {
    const template = await rules.createTemplate(owner(), { title: "Daily", frequency: "daily", startsOn: "2026-01-01" });
    const now = new Date("2026-10-05T15:00:00Z");
    await rules.raiseRecurringFor(db(), ORG, now);
    // As if a worker crashed after the insert and before writing lastRaisedOn.
    await raw`update public.task_template set last_raised_on = null where id = ${template.id}`;
    expect(await rules.raiseRecurringFor(db(), ORG, now)).toEqual([]);
    const count = await raw`select count(*)::int as n from public.task where template_id = ${template.id}`;
    expect(count[0]!.n).toBe(1);
  });

  it("raises nothing while paused, and reads the schedule back in words", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Card machine", frequency: "monthly", monthDay: 1, startsOn: "2026-01-01",
    });
    expect(template.schedule).toBe("On the 1st of every month");
    await rules.updateTemplate(owner(), { id: template.id, active: false });
    expect(await rules.raiseRecurringFor(db(), ORG, new Date("2026-11-01T15:00:00Z"))).toEqual([]);
    expect((await rules.listTemplates(owner()))[0]).toMatchObject({ active: false, nextOn: null });
  });

  it("raises an every other week task in the on weeks only", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Payroll check", frequency: "every_other_week", weekday: 1, startsOn: "2026-10-05",
    });
    expect(template.schedule).toBe("Every other Monday");
    const at = (iso: string) => rules.raiseRecurringFor(db(), ORG, new Date(iso));
    expect(await at("2026-10-05T15:00:00Z")).toHaveLength(1);
    // The Monday after is the off week, and so is every day between.
    expect(await at("2026-10-12T15:00:00Z")).toEqual([]);
    expect(await at("2026-10-14T15:00:00Z")).toEqual([]);
    expect(await at("2026-10-19T15:00:00Z")).toHaveLength(1);
    const days = await raw`select occurrence_on::text as d from public.task
      where template_id = ${template.id} order by occurrence_on`;
    expect(days.map((r) => r.d)).toEqual(["2026-10-05", "2026-10-19"]);
  });

  it("raises a weekdays only task on working days, once, and not at the weekend", async () => {
    await rules.createTemplate(owner(), { title: "Open the shop", frequency: "weekdays", startsOn: "2026-10-01" });
    const at = (iso: string) => rules.raiseRecurringFor(db(), ORG, new Date(iso));
    expect(await at("2026-10-09T15:00:00Z")).toHaveLength(1);
    expect(await at("2026-10-10T15:00:00Z")).toEqual([]);
    expect(await at("2026-10-11T15:00:00Z")).toEqual([]);
    expect(await at("2026-10-12T15:00:00Z")).toHaveLength(1);
    expect((await rules.listTemplates(owner()))[0]).toMatchObject({
      schedule: "Every weekday, Monday to Friday",
    });
  });

  it("raises a last Friday of the month task on the fourth or the fifth Friday, whichever is last", async () => {
    const template = await rules.createTemplate(owner(), {
      title: "Month end count", frequency: "last_weekday_of_month", weekday: 5, startsOn: "2026-10-01",
    });
    expect(template.nextOn).toBe("2026-10-30");
    const at = (iso: string) => rules.raiseRecurringFor(db(), ORG, new Date(iso));
    // The 23rd is a Friday but not the last one in October 2026.
    expect(await at("2026-10-23T15:00:00Z")).toEqual([]);
    expect(await at("2026-10-30T15:00:00Z")).toHaveLength(1);
    expect(await at("2026-11-20T15:00:00Z")).toEqual([]);
    expect(await at("2026-11-27T15:00:00Z")).toHaveLength(1);
  });

  it("refuses the new schedules without a weekday, and keeps the weekday only where it means something", async () => {
    await expect(rules.createTemplate(owner(), { title: "Bad", frequency: "every_other_week" }))
      .rejects.toThrow(/day of the week/);
    await expect(rules.createTemplate(owner(), { title: "Bad", frequency: "last_weekday_of_month" }))
      .rejects.toThrow(/day of the week/);
    const weekdays = await rules.createTemplate(owner(), { title: "Weekdays", frequency: "weekdays", weekday: 3 });
    expect(weekdays.weekday).toBeNull();
    // Changing a weekly task to the last of the month keeps its day, and to daily drops it.
    const weekly = await rules.createTemplate(owner(), { title: "W", frequency: "weekly", weekday: 2 });
    const changed = await rules.updateTemplate(owner(), { id: weekly.id, frequency: "last_weekday_of_month" });
    expect(changed).toMatchObject({ weekday: 2, schedule: "On the last Tuesday of every month" });
    expect((await rules.updateTemplate(owner(), { id: weekly.id, frequency: "daily" })).weekday).toBeNull();
  });

  it("refuses a weekly task with no weekday, and needs task:write", async () => {
    await expect(rules.createTemplate(owner(), { title: "Bad", frequency: "weekly" })).rejects.toThrow(/day of the week/);
    await expect(rules.createTemplate(tech(), { title: "X", frequency: "daily" })).rejects.toThrow(PermissionError);
  });
});

run("escalating late tasks", () => {
  const now = new Date("2026-10-05T18:00:00Z");
  const late = (hours: number) => new Date(now.getTime() - hours * HOUR);

  it("tells the assignee's manager once, with a task linked to the late one", async () => {
    await rules.setReportsTo(owner(), { userId: TECH, reportsToUserId: MANAGER });
    await rules.createRule(owner(), { name: "Four hours", afterHours: 4, target: "manager" });
    const task = await tasks.create(owner(), { title: "Ring Mrs Patel", assigneeUserId: TECH, dueAt: late(5) });

    expect(await rules.escalateFor(db(), ORG, now)).toHaveLength(1);
    expect(await rules.escalateFor(db(), ORG, now)).toEqual([]);

    const notices = await tasksFor(MANAGER);
    expect(notices).toEqual([{ title: "Late: Ring Mrs Patel", entity_id: task.id }]);
    const [row] = await raw`select escalated_at from public.task where id = ${task.id}`;
    expect(row!.escalated_at).not.toBeNull();

    const history = await rules.escalationsOf(owner(), { taskId: task.id });
    expect(history).toEqual([expect.objectContaining({ rule: "Four hours", notified: ["Mona Manager"] })]);
  });

  it("leaves a task that is not late enough alone", async () => {
    await rules.createRule(owner(), { name: "Day", afterHours: 24, target: "role", targetRole: "office_manager" });
    await tasks.create(owner(), { title: "Barely late", dueAt: late(2) });
    expect(await rules.escalateFor(db(), ORG, now)).toEqual([]);
  });

  it("tells the owners, and says why, when no manager is recorded", async () => {
    await rules.createRule(owner(), { name: "Four hours", afterHours: 4, target: "manager" });
    const task = await tasks.create(owner(), { title: "Chase PO", assigneeUserId: TECH, dueAt: late(6) });
    await rules.escalateFor(db(), ORG, now);
    expect((await tasksFor(OWNER)).map((t) => t.title)).toContain("Late: Chase PO");
    const [history] = await rules.escalationsOf(owner(), { taskId: task.id });
    expect(history!.note).toMatch(/No manager is recorded for Sam Tech, so the owners were told/);
  });

  it("tells a role, hands the task over, and respects the priority floor", async () => {
    await rules.createRule(owner(), {
      name: "Urgent to the office", afterHours: 1, target: "role", targetRole: "csr",
      minimumPriority: "high", reassignToUserId: MANAGER,
    });
    const urgent = await tasks.create(owner(), { title: "Burst pipe call back", priority: "urgent", assigneeUserId: TECH, dueAt: late(2) });
    await tasks.create(owner(), { title: "Low", priority: "low", assigneeUserId: TECH, dueAt: late(2) });

    expect(await rules.escalateFor(db(), ORG, now)).toEqual([{ taskId: urgent.id, ruleId: expect.any(String) }]);
    expect((await tasksFor(CSR)).map((t) => t.title)).toEqual(["Late: Burst pipe call back"]);
    const [moved] = await raw`select assignee_user_id from public.task where id = ${urgent.id}`;
    expect(moved!.assignee_user_id).toBe(MANAGER);
    const [record] = await raw`select reassigned_from_user_id, reassigned_to_user_id from public.task_escalation where task_id = ${urgent.id}`;
    expect(record).toEqual({ reassigned_from_user_id: TECH, reassigned_to_user_id: MANAGER });
  });

  it("refuses a rule naming nobody, and somebody setting themselves as their own manager", async () => {
    await expect(rules.createRule(owner(), { name: "X", afterHours: 4, target: "person" })).rejects.toThrow(/Choose who/);
    await expect(rules.createRule(owner(), { name: "X", afterHours: 0, target: "manager" })).rejects.toThrow(/whole hours/);
    await expect(rules.setReportsTo(owner(), { userId: TECH, reportsToUserId: TECH })).rejects.toThrow(/own manager/);
    await expect(rules.setReportsTo(as(MANAGER, ["office_manager"]), { userId: TECH, reportsToUserId: OWNER }))
      .rejects.toThrow(PermissionError);
  });

  it("runs from the worker's pass across companies", async () => {
    await rules.createRule(owner(), { name: "Four hours", afterHours: 4, target: "person", targetUserId: CSR });
    await rules.createTemplate(owner(), { title: "Daily", frequency: "daily", startsOn: "2026-01-01" });
    await tasks.create(owner(), { title: "Old", dueAt: late(10) });
    const results = await rules.taskPass(db(), { now });
    const ours = results.find((r) => r.organizationId === ORG);
    expect(ours).toMatchObject({ failed: [] });
    expect(ours!.raised).toHaveLength(1);
    expect(ours!.escalated).toHaveLength(1);
  });
});
