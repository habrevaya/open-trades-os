import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobHolds from "../src/services/job-holds";
import * as onCall from "../src/services/office-on-call";
import * as rules from "../src/services/task-rules";
import * as tasks from "../src/services/tasks";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A TASK GIVEN TO WHOEVER IS ON THE OFFICE ROTA TODAY
 *
 * A hold nudge (the company's setting and a rule), a recurring task and a task
 * typed in by hand can each be given to whoever is on the office rota the day
 * it is raised. One person on the rota is given the task. Two or more are each
 * told of one task that stays in the office queue. Nobody on it leaves the
 * task in the office queue and says so. A person who cannot open tasks is not
 * counted.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rotaassign:org");
const OWNER = fixtureId("rotaassign:owner");
const OLIVE = fixtureId("rotaassign:olive");
const OTTO = fixtureId("rotaassign:otto");
const DAN = fixtureId("rotaassign:dan");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, role: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, "owner");

let customerId = "";
let propertyId = "";
let seq = 0;

async function person(userId: string, role: string, name: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${name.toLowerCase()}@rota-assign.test`}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where id in ${raw([OLIVE, OTTO, DAN])}`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Rota Assign Co", slug: "rota-assign-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`update public.organization set settings = coalesce(settings, '{}'::jsonb) - 'holdNudge' - 'officeOnCall' where id = ${ORG}`;
  await person(OLIVE, "office_manager", "Olive");
  await person(OTTO, "admin", "Otto");
  await person(DAN, "dispatcher", "Dan");
  await raw`delete from public.office_on_call where organization_id = ${ORG}`;
  await raw`delete from public.job_hold_nudge_rule where organization_id = ${ORG}`;
  await raw`delete from public.task_template where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Rota Customer', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Rota Rd', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
});

const rotaToday = (userId: string) => onCall.addTurn(owner(), { userId, startsOn: companyToday(), endsOn: companyToday(1) });

const tasksNow = () => raw<{ id: string; title: string; body: string | null; queue: string | null; assignee_user_id: string | null }[]>`
  select id, title, body, queue, assignee_user_id from public.task where organization_id = ${ORG} order by created_at`;
const toldAbout = (taskId: string) => raw<{ user_id: string }[]>`
  select user_id from public.staff_notice where organization_id = ${ORG} and kind = 'task_assigned' and entity_id = ${taskId} order by user_id`;

async function heldJob(): Promise<string> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'scheduled', 'No cool') returning id`;
  const placed = await jobHolds.place(owner(), { id: job!.id, reason: "customer" });
  await raw`
    update public.job_hold set placed_at = ${raw.unsafe(`('${companyToday(-4)} 13:00'::timestamp at time zone '${ZONE}')`)}
     where id = ${placed.data.at(-1)!.id}`;
  return job!.id;
}
const pass = () => jobHolds.nudgePass(db(), { force: true });

run("the hold nudge given to whoever is on the office rota", () => {
  it("is a choice the company's setting and a rule both take, read back in words", async () => {
    const set = await jobHolds.setNudge(owner(), { days: 3, assignTo: "on_call" });
    expect(set).toMatchObject({ days: 3, assignTo: "on_call", assigneeUserId: null });
    const rule = await jobHolds.createRule(owner(), { reason: "part", assignTo: "on_call" });
    expect(rule).toMatchObject({ assignTo: "on_call" });
    expect(rule.summary).toBe("Jobs waiting on a part: give it to whoever is on the office rota today.");
  });

  it("gives the task to the one person on the rota today", async () => {
    await jobHolds.setNudge(owner(), { days: 3, assignTo: "on_call" });
    await rotaToday(OLIVE);
    await heldJob();
    await pass();
    const [task, ...more] = await tasksNow();
    expect(more).toEqual([]);
    expect(task).toMatchObject({ queue: "office", assignee_user_id: OLIVE });
    expect(task!.body).toContain("Given to Olive, who is on the office rota today.");
    expect((await toldAbout(task!.id)).map((r) => r.user_id)).toEqual([OLIVE]);
  });

  it("keeps one task in the office queue and tells each of two people on the rota", async () => {
    await jobHolds.setNudge(owner(), { days: 3, assignTo: "on_call" });
    await rotaToday(OLIVE);
    await rotaToday(OTTO);
    await heldJob();
    await pass();
    const [task] = await tasksNow();
    expect(task).toMatchObject({ queue: "office", assignee_user_id: null });
    expect(task!.body).toContain("Sent to whoever is on the office rota today: Olive and Otto.");
    expect((await toldAbout(task!.id)).map((r) => r.user_id).sort()).toEqual([OLIVE, OTTO].sort());
  });

  it("falls back to the office queue and says so when nobody is on the rota today", async () => {
    await jobHolds.setNudge(owner(), { days: 3, assignTo: "on_call" });
    await onCall.addTurn(owner(), { userId: OLIVE, startsOn: companyToday(1), endsOn: companyToday(2) });
    await heldJob();
    await pass();
    const [task] = await tasksNow();
    expect(task).toMatchObject({ queue: "office", assignee_user_id: null });
    expect(task!.body).toContain("nobody is on it today, so it stays in the office queue");
    expect(await toldAbout(task!.id)).toEqual([]);
  });

  it("does not count a person on the rota who cannot open tasks", async () => {
    await jobHolds.setNudge(owner(), { days: 3, assignTo: "on_call" });
    // A dispatcher answers a visit change, so may be on the rota, but the preset does not open tasks.
    await rotaToday(DAN);
    await heldJob();
    await pass();
    const [task] = await tasksNow();
    expect(task).toMatchObject({ assignee_user_id: null });
    expect(task!.body).toContain("nobody on it today can open tasks");
    expect(await toldAbout(task!.id)).toEqual([]);
  });

  it("is taken from the rule when a rule for the reason says so, over the company's own choice", async () => {
    await jobHolds.setNudge(owner(), { days: 3, assignTo: "nobody" });
    await jobHolds.createRule(owner(), { reason: "customer", assignTo: "on_call" });
    await rotaToday(OTTO);
    await heldJob();
    await pass();
    const [task] = await tasksNow();
    expect(task).toMatchObject({ assignee_user_id: OTTO });
  });
});

run("a recurring task given to whoever is on the office rota", () => {
  const raiseOn = (day: string) => rules.raiseRecurringFor(db(), ORG, new Date(`${day}T20:00:00Z`));

  it("is a choice instead of a person, read back, and refused beside one", async () => {
    const made = await rules.createTemplate(owner(), {
      title: "Open the post", frequency: "daily", assigneeOnCall: true, startsOn: companyToday(),
    });
    expect(made).toMatchObject({ assigneeOnCall: true, assigneeUserId: null, assigneeName: null });
    await expect(rules.createTemplate(owner(), {
      title: "Both", frequency: "daily", assigneeOnCall: true, assigneeUserId: OLIVE,
    })).rejects.toBeInstanceOf(ConflictError);
    const named = await rules.updateTemplate(owner(), { id: made.id, assigneeUserId: OLIVE });
    expect(named).toMatchObject({ assigneeOnCall: false, assigneeUserId: OLIVE });
    const back = await rules.updateTemplate(owner(), { id: made.id, assigneeOnCall: true });
    expect(back).toMatchObject({ assigneeOnCall: true, assigneeUserId: null });
    const nobody = await rules.updateTemplate(owner(), { id: made.id, assigneeUserId: null });
    expect(nobody).toMatchObject({ assigneeOnCall: false, assigneeUserId: null });
  });

  it("goes each day to whoever is on the rota that day", async () => {
    await rules.createTemplate(owner(), { title: "Open the post", frequency: "daily", assigneeOnCall: true, startsOn: companyToday() });
    const today = companyToday();
    const tomorrow = companyToday(1);
    await onCall.addTurn(owner(), { userId: OLIVE, startsOn: today, endsOn: today });
    await onCall.addTurn(owner(), { userId: OTTO, startsOn: tomorrow, endsOn: tomorrow });
    await rules.raiseRecurringFor(db(), ORG, new Date());
    await raiseOn(tomorrow);
    const made = await tasksNow();
    expect(made.map((t) => t.assignee_user_id)).toEqual([OLIVE, OTTO]);
    expect((await toldAbout(made[0]!.id)).map((r) => r.user_id)).toEqual([OLIVE]);
  });

  it("raises the task unassigned, with a line saying so, when nobody is on the rota", async () => {
    await rules.createTemplate(owner(), {
      title: "Open the post", body: "Sort it into trays.", frequency: "daily", assigneeOnCall: true, startsOn: companyToday(),
    });
    await rules.raiseRecurringFor(db(), ORG, new Date());
    const [task] = await tasksNow();
    expect(task!.assignee_user_id).toBeNull();
    expect(task!.body).toBe(
      "This was to go to whoever is on the office rota today, but nobody is on it today, so it stays in the office queue.\n\nSort it into trays.",
    );
  });
});

run("a task typed in by hand given to whoever is on the office rota", () => {
  it("is given to the one person on the rota, and refused beside a named person", async () => {
    await rotaToday(OLIVE);
    const made = await tasks.create(owner(), { title: "Ring the supplier", assigneeOnCall: true });
    expect(made.assigneeUserId).toBe(OLIVE);
    expect(made.body).toBe("Given to Olive, who is on the office rota today.");
    await expect(tasks.create(owner(), { title: "Both", assigneeOnCall: true, assigneeUserId: OTTO }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("stays in the queue and tells both when two are on the rota, and says so when nobody is", async () => {
    await rotaToday(OLIVE);
    await rotaToday(OTTO);
    const two = await tasks.create(owner(), { title: "Ring the supplier", body: "About the pump.", assigneeOnCall: true });
    expect(two.assigneeUserId).toBeNull();
    expect(two.body).toBe("Sent to whoever is on the office rota today: Olive and Otto.\n\nAbout the pump.");
    expect((await toldAbout(two.id)).map((r) => r.user_id).sort()).toEqual([OLIVE, OTTO].sort());

    await raw`delete from public.office_on_call where organization_id = ${ORG}`;
    const none = await tasks.create(owner(), { title: "Ring again", assigneeOnCall: true });
    expect(none.assigneeUserId).toBeNull();
    expect(none.body).toContain("nobody is on it today");
  });

  it("is the same permission as any task: a technician cannot write it", async () => {
    await expect(tasks.create(as(OTTO, "technician"), { title: "X", assigneeOnCall: true })).rejects.toThrow();
  });
});
