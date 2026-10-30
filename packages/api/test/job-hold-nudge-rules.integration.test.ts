import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import * as jobHolds from "../src/services/job-holds";
import * as taskRules from "../src/services/task-rules";
import * as tasks from "../src/services/tasks";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE HOLD NUDGE: WHEN IT IS DUE, HOW OFTEN IT COMES BACK, AND WHO GETS IT
 *
 * Beside the days a job may wait, a company can give the nudge a due date (so
 * the queue's late rules act on it), have it raised again while the job is
 * still on hold, and give it to nobody, whoever put the job on hold, or a
 * named person. All off by default, so a company that never asked gets the
 * task it always got.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("holdrules:org");
const USER = fixtureId("holdrules:user");
const MANAGER = fixtureId("holdrules:manager");
const LEAVER = fixtureId("holdrules:leaver");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const asUser = (userId: string, role: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => asUser(USER, "owner");

let customerId = "";
let propertyId = "";
let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

async function member(id: string, email: string, role: string, name: string) {
  await raw`delete from public."user" where id = ${id}`;
  await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role)`;
}

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Hold Rules Co", slug: "hold-rules-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await member(MANAGER, "mona@hold-rules-co.test", "office_manager", "Mona Manager");
  await member(LEAVER, "lee@hold-rules-co.test", "office_manager", "Lee Leaver");
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Dana Whitfield', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Oak', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

async function booked(summary = "No cool"): Promise<string> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'scheduled', ${summary}) returning id`;
  return job!.id;
}

/** Hold a job as `by`, then age the hold: placed at one in the afternoon `daysAgo` company days back. */
async function holdFor(jobId: string, daysAgo: number, by: ServiceContext = owner()) {
  const placed = await jobHolds.place(by, { id: jobId, reason: "customer" });
  const id = placed.data.at(-1)!.id;
  await raw`
    update public.job_hold set placed_at = ${raw.unsafe(`('${companyToday(-daysAgo)} 13:00'::timestamp at time zone '${ZONE}')`)}
     where id = ${id}`;
  return id;
}

interface TaskRow {
  id: string; title: string; body: string; queue: string | null; status: string;
  assignee_user_id: string | null; due_at: Date | null;
}
const nudgeTasks = () => raw<TaskRow[]>`
  select id, title, body, queue, status, assignee_user_id, due_at from public.task
   where organization_id = ${ORG} and entity_type = 'job' order by created_at`;

/**
 * The worker's pass over THIS company only, at a clock the test chooses. Not
 * the all-company pass: files run side by side, and a pass at a made up
 * clock over everybody's holds would nudge another file's company early.
 */
const pass = async (now = new Date()) => {
  const worker: ServiceContext = {
    actor: {
      userId: SYSTEM_USER_ID, organizationId: ORG, roles: [], grants: ["task:read", "task:write"], agentId: "job-hold-nudges",
    },
    db: db(),
  };
  return inTenant(worker, (tx) => jobHolds.nudgesIn(tx, worker, now));
};

/** A day (or more) later: the clock the worker is handed, at noon in the company's day. */
const noonIn = (daysFromToday: number) => new Date(`${companyToday(daysFromToday)}T18:00:00Z`);

run("the settings, as a patch", () => {
  it("are off by default and read back with the new fields empty", async () => {
    expect(await jobHolds.nudgeSetting(owner())).toEqual({
      days: null, dueDays: null, repeatDays: null, assignTo: "nobody", assigneeUserId: null, assigneeName: null,
    });
  });

  it("keeps what a caller leaves out, so one that only sends the days changes only the days", async () => {
    await jobHolds.setNudge(owner(), { days: 3, dueDays: 2, repeatDays: 5, assignTo: "placed_by" });
    const after = await jobHolds.setNudge(owner(), { days: 7 });
    expect(after).toMatchObject({ days: 7, dueDays: 2, repeatDays: 5, assignTo: "placed_by" });
    expect(await jobHolds.setNudge(owner(), { dueDays: null, repeatDays: null })).toMatchObject({
      days: 7, dueDays: null, repeatDays: null,
    });
  });

  it("names the person, and forgets them when the task goes to somebody else", async () => {
    const named = await jobHolds.setNudge(owner(), { days: 3, assignTo: "person", assigneeUserId: MANAGER });
    expect(named).toMatchObject({ assignTo: "person", assigneeUserId: MANAGER, assigneeName: "Mona Manager" });
    const back = await jobHolds.setNudge(owner(), { assignTo: "nobody" });
    expect(back).toMatchObject({ assignTo: "nobody", assigneeUserId: null, assigneeName: null });
  });

  it("refuses numbers out of range, a person with no name, and somebody who has left", async () => {
    await expect(jobHolds.setNudge(owner(), { dueDays: 31 })).rejects.toBeInstanceOf(ConflictError);
    await expect(jobHolds.setNudge(owner(), { dueDays: -1 })).rejects.toThrow(/whole number from 0 to 30/);
    await expect(jobHolds.setNudge(owner(), { repeatDays: 0 })).rejects.toThrow(/whole number from 1 to 90/);
    await expect(jobHolds.setNudge(owner(), { repeatDays: 91 })).rejects.toBeInstanceOf(ConflictError);
    await expect(jobHolds.setNudge(owner(), { assignTo: "person" })).rejects.toThrow(/Choose which person/);
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${LEAVER}`;
    await expect(jobHolds.setNudge(owner(), { assignTo: "person", assigneeUserId: LEAVER }))
      .rejects.toThrow(/works here now/);
    await expect(jobHolds.setNudge(owner(), { assignTo: "person", assigneeUserId: fixtureId("holdrules:stranger") }))
      .rejects.toThrow(/works here now/);
    expect(await jobHolds.nudgeSetting(owner())).toMatchObject({ days: null, dueDays: null, assignTo: "nobody" });
  });

  it("are the company's to change, and are audited with what they were", async () => {
    await expect(jobHolds.setNudge(asUser(MANAGER, "technician"), { dueDays: 2 })).rejects.toThrow(PermissionError);
    await jobHolds.setNudge(owner(), { days: 2, dueDays: 1 });
    const [row] = await raw<{ before: { dueDays: number | null }; after: { dueDays: number | null } }[]>`
      select before, after from public.audit_log
       where organization_id = ${ORG} and action = 'organization.hold_nudge_set'`;
    expect(row!.before.dueDays).toBeNull();
    expect(row!.after.dueDays).toBe(1);
  });
});

run("the task a company that never asked gets", () => {
  it("has no due date and no person, and is raised once however long the job waits", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    await holdFor(await booked(), 3);
    await pass();
    await pass(noonIn(30));
    const [task, ...more] = await nudgeTasks();
    expect(more).toEqual([]);
    expect(task).toMatchObject({ queue: "office", assignee_user_id: null, due_at: null, status: "open" });
    expect(task!.title).toBe("Job 1 has been on hold 3 days: waiting on the customer");
  });
});

run("a due date on the nudge", () => {
  it("is the end of the company day that many days on, and the queue's late rules then act on it", async () => {
    await jobHolds.setNudge(owner(), { days: 2, dueDays: 2 });
    await holdFor(await booked(), 3);
    await pass();
    const [task] = await nudgeTasks();
    const [expected] = await raw<{ due: Date }[]>`
      select (${companyToday(3)}::date::timestamp at time zone ${ZONE}) as due`;
    expect(task!.due_at!.toISOString()).toBe(expected!.due.toISOString());

    // Before the due day is over it is not late; once it is, a rule an hour long tells the manager.
    await raw`update public."user" set name = 'Ana Ruiz' where id = ${USER}`;
    await raw`update public.membership set reports_to_user_id = ${MANAGER} where organization_id = ${ORG} and user_id = ${USER}`;
    await taskRules.createRule(owner(), { name: "One hour late", afterHours: 1, target: "person", targetUserId: MANAGER });
    await raw`update public.task set assignee_user_id = ${USER} where id = ${task!.id}`;
    expect(await taskRules.escalateFor(db(), ORG, noonIn(1))).toEqual([]);
    const done = await taskRules.escalateFor(db(), ORG, noonIn(5));
    expect(done).toEqual([expect.objectContaining({ taskId: task!.id })]);
    const [escalated] = await raw<{ escalated_at: Date | null }[]>`select escalated_at from public.task where id = ${task!.id}`;
    expect(escalated!.escalated_at).not.toBeNull();
  });

  it("can be due the day it is raised", async () => {
    await jobHolds.setNudge(owner(), { days: 1, dueDays: 0 });
    await holdFor(await booked(), 2);
    await pass();
    const [task] = await nudgeTasks();
    const [expected] = await raw<{ due: Date }[]>`
      select ((${companyToday(1)}::date)::timestamp at time zone ${ZONE}) as due`;
    expect(task!.due_at!.toISOString()).toBe(expected!.due.toISOString());
  });
});

run("who the nudge goes to", () => {
  it("goes to whoever put the job on hold, who is told", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "placed_by" });
    await holdFor(await booked(), 3, asUser(MANAGER, "office_manager"));
    await pass();
    const [task] = await nudgeTasks();
    expect(task).toMatchObject({ assignee_user_id: MANAGER, queue: "office" });
    const told = await raw`
      select 1 from public.staff_notice where organization_id = ${ORG} and user_id = ${MANAGER} and kind = 'task_assigned'`;
    expect(told).toHaveLength(1);
  });

  it("goes to the named person whoever put the job on hold", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "person", assigneeUserId: MANAGER });
    await holdFor(await booked(), 3);
    await pass();
    expect((await nudgeTasks())[0]).toMatchObject({ assignee_user_id: MANAGER });
    const mine = await tasks.list(asUser(MANAGER, "office_manager"), { view: "mine" });
    expect(mine.data.map((t) => t.title)).toContain("Job 1 has been on hold 3 days: waiting on the customer");
  });

  it("stays in the office queue when the person it was for has left", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "person", assigneeUserId: LEAVER });
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${LEAVER}`;
    await holdFor(await booked(), 3);
    await pass();
    expect((await nudgeTasks())[0]).toMatchObject({ assignee_user_id: null, queue: "office" });
  });

  it("stays in the office queue when whoever put the job on hold has left", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "placed_by" });
    const holdId = await holdFor(await booked(), 3, asUser(LEAVER, "office_manager"));
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${LEAVER}`;
    await pass();
    expect((await nudgeTasks())[0]).toMatchObject({ assignee_user_id: null, queue: "office" });
    expect(holdId).toBeTruthy();
  });
});

run("a nudge that comes back while the job stays on hold", () => {
  it("is not raised again when the company never asked", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    await holdFor(await booked(), 3);
    await pass();
    const [first] = await nudgeTasks();
    await raw`update public.task set status = 'dismissed', outcome = 'Rang them' where id = ${first!.id}`;
    await pass(noonIn(40));
    expect(await nudgeTasks()).toHaveLength(1);
  });

  it("is raised again that many days later once the last one was closed, and says so", async () => {
    await jobHolds.setNudge(owner(), { days: 2, repeatDays: 3 });
    const jobId = await booked();
    const holdId = await holdFor(jobId, 3);
    await pass();
    const [first] = await nudgeTasks();
    await raw`update public.task set status = 'dismissed', outcome = 'Rang them' where id = ${first!.id}`;
    // Too soon: the last one was raised today.
    await pass(noonIn(2));
    expect(await nudgeTasks()).toHaveLength(1);

    await pass(noonIn(3));
    const all = await nudgeTasks();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ status: "open", title: "Job 1 is still on hold 6 days: waiting on the customer" });
    expect(all[1]!.body).toContain("This is reminder 2 for this hold.");
    const [hold] = await raw<{ nudge_count: number; nudge_task_id: string }[]>`
      select nudge_count, nudge_task_id from public.job_hold where id = ${holdId}`;
    expect(hold).toMatchObject({ nudge_count: 2, nudge_task_id: all[1]!.id });
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'job.hold_nudged'`;
    expect(audited).toHaveLength(2);
  });

  it("never piles a second task on one that is still open: the open one is the nudge, and goes late on its own", async () => {
    await jobHolds.setNudge(owner(), { days: 2, repeatDays: 2 });
    await holdFor(await booked(), 3);
    await pass();
    await pass(noonIn(10));
    await pass(noonIn(20));
    expect(await nudgeTasks()).toHaveLength(1);
  });

  it("is raised once for a pass however many workers come round", async () => {
    await jobHolds.setNudge(owner(), { days: 2, repeatDays: 2 });
    await holdFor(await booked(), 3);
    await pass();
    const [first] = await nudgeTasks();
    await raw`update public.task set status = 'done' where id = ${first!.id}`;
    await Promise.all([pass(noonIn(4)), pass(noonIn(4)), pass(noonIn(4))]);
    expect(await nudgeTasks()).toHaveLength(2);
  });

  it("stops when the job comes off hold, and closes the latest task", async () => {
    await jobHolds.setNudge(owner(), { days: 2, repeatDays: 2 });
    const jobId = await booked();
    const holdId = await holdFor(jobId, 3);
    await pass();
    const [first] = await nudgeTasks();
    await raw`update public.task set status = 'dismissed' where id = ${first!.id}`;
    await pass(noonIn(3));
    await jobHolds.release(owner(), { id: holdId });
    const all = await nudgeTasks();
    expect(all.map((t) => t.status)).toEqual(["dismissed", "done"]);
    await pass(noonIn(30));
    expect(await nudgeTasks()).toHaveLength(2);
  });

  it("finds the company through the worker's cross-company lookup, and only when it asked", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    await holdFor(await booked(), 3);
    await pass();
    const listed = () => raw<{ organization_id: string }[]>`select organization_id from app.job_hold_nudge_organizations(500)`;
    // Nudged already and no repeat asked for: nothing left for the worker to do here.
    expect((await listed()).map((r) => r.organization_id)).not.toContain(ORG);
    await raw`update public.job_hold set nudged_at = now() - interval '5 days' where organization_id = ${ORG}`;
    await jobHolds.setNudge(owner(), { repeatDays: 3 });
    expect((await listed()).map((r) => r.organization_id)).toContain(ORG);
    await jobHolds.setNudge(owner(), { repeatDays: 10 });
    expect((await listed()).map((r) => r.organization_id)).not.toContain(ORG);
  });

  it("counts a hold nudged before repeats existed as nudged once", async () => {
    await jobHolds.setNudge(owner(), { days: 2, repeatDays: 2 });
    const holdId = await holdFor(await booked(), 6);
    // As the old worker left it: a task, a time, and no count.
    const [old] = await raw<{ id: string }[]>`
      insert into public.task (organization_id, title, entity_type, entity_id, queue, status)
      select ${ORG}, 'old nudge', 'job', job_id, 'office', 'done' from public.job_hold where id = ${holdId} returning id`;
    await raw`update public.job_hold set nudged_at = ${raw.unsafe(`('${companyToday(-3)} 09:00'::timestamp at time zone '${ZONE}')`)},
                     nudge_task_id = ${old!.id}, nudge_count = 0 where id = ${holdId}`;
    await pass();
    const [hold] = await raw<{ nudge_count: number }[]>`select nudge_count from public.job_hold where id = ${holdId}`;
    expect(hold!.nudge_count).toBe(2);
    expect((await nudgeTasks()).at(-1)!.body).toContain("This is reminder 2 for this hold.");
  });
});
