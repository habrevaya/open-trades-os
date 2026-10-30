import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import * as jobHolds from "../src/services/job-holds";
import { ConflictError, inTenant, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE HOLD NUDGE BY REASON AND BY BRANCH, AND TO A ROLE
 *
 * The company's numbers are the default. A rule changes some of them for one
 * reason, one branch or both, and the task can go to everybody in a role or to
 * the manager of the job's branch. A company with no rules gets exactly the
 * task it always got (job-hold-nudge-rules.integration.test.ts keeps that).
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("holdreason:org");
const USER = fixtureId("holdreason:user");
const OFFICE_A = fixtureId("holdreason:office-a");
const OFFICE_B = fixtureId("holdreason:office-b");
const HOUSTON_MGR = fixtureId("holdreason:houston-manager");
const AUSTIN_MGR = fixtureId("holdreason:austin-manager");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const asUser = (userId: string, role: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => asUser(USER, "owner");

let customerId = "";
let propertyId = "";
let houston = "";
let austin = "";
let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

async function member(id: string, email: string, role: string, name: string, unit: string | null = null) {
  await raw`delete from public."user" where id = ${id}`;
  await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role, business_unit_id)
            values (${ORG}, ${id}, ${role}::member_role, ${unit})`;
}

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Hold Reason Co", slug: "hold-reason-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public.job_hold_nudge_rule where organization_id = ${ORG}`;
  [{ id: houston }] = await raw<{ id: string }[]>`
    insert into public.business_unit (organization_id, name, code) values (${ORG}, 'Houston', 'HOU') returning id` as [{ id: string }];
  [{ id: austin }] = await raw<{ id: string }[]>`
    insert into public.business_unit (organization_id, name, code) values (${ORG}, 'Austin', 'AUS') returning id` as [{ id: string }];
  await member(OFFICE_A, "ada@hold-reason-co.test", "office_manager", "Ada Office");
  await member(OFFICE_B, "bo@hold-reason-co.test", "office_manager", "Bo Office");
  await member(HOUSTON_MGR, "hank@hold-reason-co.test", "branch_manager", "Hank Houston", houston);
  await member(AUSTIN_MGR, "amy@hold-reason-co.test", "branch_manager", "Amy Austin", austin);
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Dana Whitfield', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Oak', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

async function booked(branch: string | null = null): Promise<string> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'scheduled', ${`Job ${seq}`}, ${branch}) returning id`;
  return job!.id;
}

type Reason = "customer" | "weather" | "inspection" | "other";

/** Hold a job for a reason, then age the hold: placed at one in the afternoon `daysAgo` company days back. */
async function holdFor(jobId: string, reason: Reason, daysAgo: number) {
  const placed = await jobHolds.place(owner(), {
    id: jobId, reason, ...(reason === "inspection" || reason === "other" ? { note: "Rough in" } : {}),
  });
  const id = placed.data.at(-1)!.id;
  await raw`
    update public.job_hold set placed_at = ${raw.unsafe(`('${companyToday(-daysAgo)} 13:00'::timestamp at time zone '${ZONE}')`)}
     where id = ${id}`;
  return id;
}

interface TaskRow {
  id: string; title: string; body: string; queue: string | null; status: string;
  assignee_user_id: string | null; due_at: Date | null; entity_id: string;
}
const nudgeTasks = () => raw<TaskRow[]>`
  select id, title, body, queue, status, assignee_user_id, due_at, entity_id from public.task
   where organization_id = ${ORG} and entity_type = 'job' order by created_at`;
const tasksFor = async (jobId: string) => (await nudgeTasks()).filter((t) => t.entity_id === jobId);

/** The worker's pass over this company only, at a clock the test chooses. */
const pass = async (now = new Date()) => {
  const worker: ServiceContext = {
    actor: {
      userId: SYSTEM_USER_ID, organizationId: ORG, roles: [], grants: ["task:read", "task:write"], agentId: "job-hold-nudges",
    },
    db: db(),
  };
  return inTenant(worker, (tx) => jobHolds.nudgesIn(tx, worker, now));
};
const noonIn = (daysFromToday: number) => new Date(`${companyToday(daysFromToday)}T18:00:00Z`);

const toldAbout = (taskId: string) => raw<{ user_id: string }[]>`
  select user_id from public.staff_notice where organization_id = ${ORG} and entity_type = 'task' and entity_id = ${taskId}`;

run("days that differ by reason", () => {
  it("nudges each reason by its own days and leaves the rest to the company's", async () => {
    await jobHolds.setNudge(owner(), { days: 5 });
    await jobHolds.createRule(owner(), { reason: "weather", days: 10 });
    await jobHolds.createRule(owner(), { reason: "customer", days: 2 });
    const weather6 = await booked(); await holdFor(weather6, "weather", 6);
    const weather11 = await booked(); await holdFor(weather11, "weather", 11);
    const customer3 = await booked(); await holdFor(customer3, "customer", 3);
    const inspection3 = await booked(); await holdFor(inspection3, "inspection", 3);
    const inspection5 = await booked(); await holdFor(inspection5, "inspection", 5);
    await pass();
    const raised = (await nudgeTasks()).map((t) => t.entity_id).sort();
    expect(raised).toEqual([weather11, customer3, inspection5].sort());
  });

  it("nudges only the reasons a rule names when the company itself is off", async () => {
    await jobHolds.createRule(owner(), { reason: "weather", days: 3 });
    const wet = await booked(); await holdFor(wet, "weather", 4);
    const waiting = await booked(); await holdFor(waiting, "customer", 40);
    await pass();
    expect((await nudgeTasks()).map((t) => t.entity_id)).toEqual([wet]);
    expect((await jobHolds.nudgeSetting(owner())).days).toBeNull();
  });

  it("can turn the nudge off for one reason", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    await jobHolds.createRule(owner(), { reason: "weather", days: null });
    const wet = await booked(); await holdFor(wet, "weather", 30);
    const waiting = await booked(); await holdFor(waiting, "customer", 3);
    await pass();
    expect((await nudgeTasks()).map((t) => t.entity_id)).toEqual([waiting]);
  });

  it("takes a due date, a repeat and a person for a reason, and the rest from the company", async () => {
    await jobHolds.setNudge(owner(), { days: 2, dueDays: 5, repeatDays: 9 });
    await jobHolds.createRule(owner(), {
      reason: "inspection", dueDays: 0, repeatDays: null, assignTo: "person", assigneeUserId: OFFICE_A,
    });
    const jobId = await booked(); const holdId = await holdFor(jobId, "inspection", 3);
    await pass();
    const [task] = await tasksFor(jobId);
    const [expected] = await raw<{ due: Date }[]>`select ((${companyToday(1)}::date)::timestamp at time zone ${ZONE}) as due`;
    expect(task).toMatchObject({ assignee_user_id: OFFICE_A, queue: "office" });
    expect(task!.due_at!.toISOString()).toBe(expected!.due.toISOString());
    /** No repeat for inspections even though the company repeats. */
    await raw`update public.task set status = 'dismissed' where id = ${task!.id}`;
    await pass(noonIn(20));
    expect(await tasksFor(jobId)).toHaveLength(1);
    expect(holdId).toBeTruthy();
  });
});

run("days that differ by branch, and which rule wins", () => {
  it("nudges a branch by its own days and a job in no branch by the company's", async () => {
    await jobHolds.setNudge(owner(), { days: 5 });
    await jobHolds.createRule(owner(), { businessUnitId: houston, days: 1 });
    const inHouston = await booked(houston); await holdFor(inHouston, "customer", 2);
    const inAustin = await booked(austin); await holdFor(inAustin, "customer", 2);
    const nowhere = await booked(); await holdFor(nowhere, "customer", 2);
    await pass();
    expect((await nudgeTasks()).map((t) => t.entity_id)).toEqual([inHouston]);
  });

  it("goes by the reason in the branch, then the reason, then the branch, field by field", async () => {
    await jobHolds.setNudge(owner(), { days: 20, dueDays: 9 });
    await jobHolds.createRule(owner(), { businessUnitId: houston, days: 8, dueDays: 1 });
    await jobHolds.createRule(owner(), { reason: "weather", days: 6 });
    await jobHolds.createRule(owner(), { reason: "weather", businessUnitId: houston, days: 3 });
    const a = await booked(houston); await holdFor(a, "weather", 4);
    const b = await booked(austin); await holdFor(b, "weather", 4);
    const c = await booked(austin); await holdFor(c, "weather", 7);
    const d = await booked(houston); await holdFor(d, "customer", 5);
    const e = await booked(houston); await holdFor(e, "customer", 9);
    await pass();
    expect((await nudgeTasks()).map((t) => t.entity_id).sort()).toEqual([a, c, e].sort());
    /** The branch's due date applies to the customer hold; the reason in the branch says nothing of one. */
    const [forE] = await tasksFor(e);
    const [dayOne] = await raw<{ due: Date }[]>`select ((${companyToday(2)}::date)::timestamp at time zone ${ZONE}) as due`;
    expect(forE!.due_at!.toISOString()).toBe(dayOne!.due.toISOString());
  });

  it("stops applying when its branch goes", async () => {
    await jobHolds.setNudge(owner(), { days: 20 });
    const rule = await jobHolds.createRule(owner(), { businessUnitId: houston, days: 1 });
    await raw`delete from public.business_unit where id = ${houston}`;
    expect((await jobHolds.listRules(owner())).data.map((r) => r.id)).not.toContain(rule.id);
  });
});

run("a task given to a role", () => {
  it("stays one task in the office queue, and tells everybody who holds the role", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "role", assigneeRole: "office_manager" });
    expect(await jobHolds.nudgeSetting(owner())).toMatchObject({ assignTo: "role", assigneeRole: "office_manager" });
    const jobId = await booked(); await holdFor(jobId, "customer", 3);
    await pass();
    const tasks = await tasksFor(jobId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignee_user_id: null, queue: "office" });
    expect(tasks[0]!.body.startsWith("Sent to the office managers. ")).toBe(true);
    expect((await toldAbout(tasks[0]!.id)).map((n) => n.user_id).sort()).toEqual([OFFICE_A, OFFICE_B].sort());
    const [audit] = await raw<{ after: { toldUserIds: string[]; assignTo: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'job.hold_nudged'`;
    expect(audit!.after).toMatchObject({ assignTo: "role" });
    expect(audit!.after.toldUserIds.sort()).toEqual([OFFICE_A, OFFICE_B].sort());
  });

  it("is a rule's choice for one reason", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    await jobHolds.createRule(owner(), { reason: "weather", assignTo: "role", assigneeRole: "office_manager" });
    const wet = await booked(); await holdFor(wet, "weather", 3);
    const other = await booked(); await holdFor(other, "customer", 3);
    await pass();
    expect((await toldAbout((await tasksFor(wet))[0]!.id))).toHaveLength(2);
    expect((await toldAbout((await tasksFor(other))[0]!.id))).toHaveLength(0);
  });

  it("stays in the office queue, and says why, when nobody holds the role", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "role", assigneeRole: "accountant" });
    const jobId = await booked(); await holdFor(jobId, "customer", 3);
    await pass();
    const [task] = await tasksFor(jobId);
    expect(task).toMatchObject({ assignee_user_id: null, queue: "office" });
    expect(task!.body).toContain("nobody holds that role now, so it stays in the office queue");
  });

  it("leaves out somebody who has left", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "role", assigneeRole: "office_manager" });
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${OFFICE_B}`;
    const jobId = await booked(); await holdFor(jobId, "customer", 3);
    await pass();
    expect((await toldAbout((await tasksFor(jobId))[0]!.id)).map((n) => n.user_id)).toEqual([OFFICE_A]);
  });

  it("is refused without a role, and for a role that does not work in the office", async () => {
    await expect(jobHolds.setNudge(owner(), { assignTo: "role" })).rejects.toThrow(/Choose which role/);
    await expect(jobHolds.createRule(owner(), { reason: "part", assignTo: "role" })).rejects.toThrow(/Choose which role/);
    await expect(jobHolds.createRule(owner(), { reason: "part", assignTo: "role", assigneeRole: "technician" as never }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

run("a task given to the branch's manager", () => {
  it("goes to the managers of the job's own branch only", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "branch_manager" });
    const inHouston = await booked(houston); await holdFor(inHouston, "customer", 3);
    await pass();
    const [task] = await tasksFor(inHouston);
    expect(task).toMatchObject({ assignee_user_id: null, queue: "office" });
    expect(task!.body.startsWith("Sent to the manager of the job's branch. ")).toBe(true);
    expect((await toldAbout(task!.id)).map((n) => n.user_id)).toEqual([HOUSTON_MGR]);
  });

  it("stays in the office queue, and says why, for a job in no branch or a branch with no manager", async () => {
    await jobHolds.setNudge(owner(), { days: 2, assignTo: "branch_manager" });
    const nowhere = await booked(); await holdFor(nowhere, "customer", 3);
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${AUSTIN_MGR}`;
    const inAustin = await booked(austin); await holdFor(inAustin, "customer", 3);
    await pass();
    expect((await tasksFor(nowhere))[0]!.body).toContain("the job is in no branch, so it stays in the office queue");
    expect((await tasksFor(inAustin))[0]!.body).toContain("the branch has none now, so it stays in the office queue");
    expect(await toldAbout((await tasksFor(nowhere))[0]!.id)).toHaveLength(0);
  });

  it("is what a rule for a branch can say", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    await jobHolds.createRule(owner(), { businessUnitId: austin, assignTo: "branch_manager" });
    const inAustin = await booked(austin); await holdFor(inAustin, "customer", 3);
    const inHouston = await booked(houston); await holdFor(inHouston, "customer", 3);
    await pass();
    expect((await toldAbout((await tasksFor(inAustin))[0]!.id)).map((n) => n.user_id)).toEqual([AUSTIN_MGR]);
    expect(await toldAbout((await tasksFor(inHouston))[0]!.id)).toHaveLength(0);
  });
});

run("the rules themselves", () => {
  it("are read back in words, with what they change", async () => {
    const made = await jobHolds.createRule(owner(), {
      reason: "weather", businessUnitId: houston, days: 7, dueDays: 2, repeatDays: 3, assignTo: "role", assigneeRole: "office_manager",
    });
    expect(made).toMatchObject({
      reason: "weather", reasonLabel: "Waiting on the weather", businessUnitId: houston, businessUnitName: "Houston",
      days: 7, dueDays: 2, repeatDays: 3, assignTo: "role", assigneeRole: "office_manager",
      summary: "Jobs waiting on the weather, in Houston: nudge after 7 days, due 2 days later, remind every 3 days, give it to the office managers.",
    });
    const named = await jobHolds.createRule(owner(), { businessUnitId: austin, assignTo: "person", assigneeUserId: OFFICE_A });
    expect(named).toMatchObject({ assigneeName: "Ada Office", summary: "Jobs on hold, in Austin: give it to Ada Office." });
    expect((await jobHolds.listRules(owner())).data.map((r) => r.id)).toEqual([made.id, named.id]);
  });

  it("refuse a rule for everything, one that changes nothing, a second for the same reach, and numbers out of range", async () => {
    await expect(jobHolds.createRule(owner(), { days: 3 })).rejects.toThrow(/Choose a reason, a branch or both/);
    await expect(jobHolds.createRule(owner(), { reason: "part" })).rejects.toThrow(/Say what is different/);
    await expect(jobHolds.createRule(owner(), { reason: "part", days: 91 })).rejects.toThrow(/from 1 to 90/);
    await expect(jobHolds.createRule(owner(), { reason: "part", dueDays: 31 })).rejects.toThrow(/from 0 to 30/);
    await expect(jobHolds.createRule(owner(), { reason: "part", assignTo: "person" })).rejects.toThrow(/Choose which person/);
    await jobHolds.createRule(owner(), { reason: "part", days: 3 });
    await expect(jobHolds.createRule(owner(), { reason: "part", days: 4 })).rejects.toThrow(/There is already a rule for that reason and branch/);
    /** The same reason in a branch, and the branch alone, are other reaches. */
    await jobHolds.createRule(owner(), { reason: "part", businessUnitId: houston, days: 4 });
    await jobHolds.createRule(owner(), { businessUnitId: houston, days: 5 });
    await expect(jobHolds.createRule(owner(), { businessUnitId: houston, days: 6 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuse a person who has left and a branch that is not here", async () => {
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${OFFICE_B}`;
    await expect(jobHolds.createRule(owner(), { reason: "part", assignTo: "person", assigneeUserId: OFFICE_B }))
      .rejects.toThrow(/works here now/);
    await expect(jobHolds.createRule(owner(), { businessUnitId: fixtureId("holdreason:nowhere"), days: 2 }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("are the company's to change, and are audited with what they were", async () => {
    await expect(jobHolds.createRule(asUser(OFFICE_A, "technician"), { reason: "part", days: 2 })).rejects.toThrow(PermissionError);
    await expect(jobHolds.listRules(asUser(OFFICE_A, "technician"))).rejects.toThrow(PermissionError);
    const made = await jobHolds.createRule(owner(), { reason: "part", days: 2 });
    await expect(jobHolds.updateRule(asUser(OFFICE_A, "technician"), { id: made.id, days: 3 })).rejects.toThrow(PermissionError);
    await expect(jobHolds.deleteRule(asUser(OFFICE_A, "technician"), { id: made.id })).rejects.toThrow(PermissionError);
    await jobHolds.updateRule(owner(), { id: made.id, days: 3 });
    await jobHolds.deleteRule(owner(), { id: made.id });
    const actions = await raw<{ action: string; before: { overrides?: { days: number } } | null; after: { overrides?: { days: number } } | null }[]>`
      select action, before, after from public.audit_log
       where organization_id = ${ORG} and action like 'job_hold_nudge_rule.%' order by created_at`;
    expect(actions.map((a) => a.action)).toEqual([
      "job_hold_nudge_rule.created", "job_hold_nudge_rule.updated", "job_hold_nudge_rule.deleted",
    ]);
    expect(actions[1]!.before!.overrides!.days).toBe(2);
    expect(actions[1]!.after!.overrides!.days).toBe(3);
    expect(actions[2]!.before!.overrides!.days).toBe(3);
    expect(actions[2]!.after).toBeNull();
  });

  it("keep what an edit leaves out, hand a field back with clear, and refuse an empty rule", async () => {
    const made = await jobHolds.createRule(owner(), { reason: "part", days: 2, dueDays: 1, assignTo: "branch_manager" });
    const changed = await jobHolds.updateRule(owner(), { id: made.id, days: 6 });
    expect(changed).toMatchObject({ days: 6, dueDays: 1, assignTo: "branch_manager" });
    const noDue = await jobHolds.updateRule(owner(), { id: made.id, dueDays: null });
    expect(noDue.dueDays).toBeNull();
    const back = await jobHolds.updateRule(owner(), { id: made.id, clear: ["dueDays", "assign"] });
    expect(back).not.toHaveProperty("dueDays");
    expect(back).not.toHaveProperty("assignTo");
    await expect(jobHolds.updateRule(owner(), { id: made.id, clear: ["days"] })).rejects.toThrow(/changes nothing/);
    await expect(jobHolds.updateRule(owner(), { id: fixtureId("holdreason:gone"), days: 3 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answer a retry with the first answer", async () => {
    const keyed = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: key });
    const first = await jobHolds.createRule(keyed("hold-rule-1"), { reason: "part", days: 2 });
    const again = await jobHolds.createRule(keyed("hold-rule-1"), { reason: "part", days: 2 });
    expect(again).toEqual(first);
    expect((await jobHolds.listRules(owner())).data).toHaveLength(1);
    const gone = await jobHolds.deleteRule(keyed("hold-rule-2"), { id: first.id });
    expect(await jobHolds.deleteRule(keyed("hold-rule-2"), { id: first.id })).toEqual(gone);
  });

  it("let the worker find a company whose only nudges are in its rules", async () => {
    const listed = () => raw<{ organization_id: string }[]>`select organization_id from app.job_hold_nudge_organizations(500)`;
    const jobId = await booked(); await holdFor(jobId, "weather", 3);
    expect((await listed()).map((r) => r.organization_id)).not.toContain(ORG);
    await jobHolds.createRule(owner(), { reason: "weather", days: 2 });
    expect((await listed()).map((r) => r.organization_id)).toContain(ORG);
    await raw`update public.job_hold set nudged_at = now() where organization_id = ${ORG}`;
    expect((await listed()).map((r) => r.organization_id)).not.toContain(ORG);
    await jobHolds.createRule(owner(), { reason: "customer", repeatDays: 1 });
    await raw`update public.job_hold set nudged_at = now() - interval '2 days' where organization_id = ${ORG}`;
    expect((await listed()).map((r) => r.organization_id)).toContain(ORG);
  });

  it("do not change a company that has none: the one setting still gives the task it always did", async () => {
    await jobHolds.setNudge(owner(), { days: 2 });
    const jobId = await booked(houston); await holdFor(jobId, "weather", 3);
    await pass();
    const [task] = await tasksFor(jobId);
    expect(task).toMatchObject({ assignee_user_id: null, queue: "office", due_at: null });
    expect(task!.body.startsWith("Sent to")).toBe(false);
  });
});
