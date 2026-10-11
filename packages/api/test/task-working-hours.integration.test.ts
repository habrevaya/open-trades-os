import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as tasks from "../src/services/tasks";
import * as rules from "../src/services/task-rules";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * ESCALATING BY WORKING HOURS
 *
 * A rule can count the company's own hours: inside its business hours, on a
 * day it is open, not on a holiday. The default counts the clock, as before.
 * The company here is in Chicago, open eight to five on weekdays, and
 * 2026-10-05 is a Monday.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("twh:org");
const OWNER = fixtureId("twh:owner");
const CSR = fixtureId("twh:csr");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A Chicago wall clock time as an instant. */
const chicago = async (local: string): Promise<Date> => {
  const [row] = await raw<{ at: Date }[]>`select (${local}::timestamp at time zone ${ZONE}) as at`;
  return row!.at;
};

const noticesFor = (userId: string) => raw<{ title: string; body: string | null }[]>`
  select title, body from public.task where organization_id = ${ORG} and assignee_user_id = ${userId} order by created_at`;

async function openWeekdays() {
  await raw`delete from public.business_hours where organization_id = ${ORG}`;
  for (const day of [1, 2, 3, 4, 5]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '08:00', '17:00')`;
  }
  for (const day of [0, 6]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, closed) values (${ORG}, ${day}, true)`;
  }
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Working Hours Co", slug: "working-hours-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public.user where id = ${CSR}`;
  await raw`insert into public."user" (id, email, name) values (${CSR}, 'csr@working-hours.test', 'Cass Csr')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${CSR}, 'csr'::member_role)`;
  for (const table of ["task_escalation", "task_escalation_rule", "task", "company_holiday", "business_hours"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("a rule that counts working hours", () => {
  it("waits for Monday and Tuesday's open hours, where the clock would have fired on Saturday", async () => {
    await openWeekdays();
    const clock = await rules.createRule(owner(), { name: "Clock", afterHours: 12, target: "person", targetUserId: CSR });
    const working = await rules.createRule(owner(), {
      name: "Working", afterHours: 12, workingHours: true, target: "person", targetUserId: CSR,
    });
    expect(clock.workingHours).toBe(false);
    expect(working.workingHours).toBe(true);
    expect(working.summary).toBe("When a task is 12 working hours late, tell Cass Csr.");

    // Due Friday at five in the afternoon.
    const task = await tasks.create(owner(), { title: "Ring Mrs Patel", dueAt: await chicago("2026-10-02 17:00") });

    // Saturday morning: sixteen clock hours late, no working hours.
    const saturday = await rules.escalateFor(db(), ORG, await chicago("2026-10-03 09:00"));
    expect(saturday).toEqual([{ taskId: task.id, ruleId: clock.id }]);

    // Tuesday at ten fifty nine is eleven working hours and fifty nine minutes.
    expect(await rules.escalateFor(db(), ORG, await chicago("2026-10-06 10:59"))).toEqual([]);
    const tuesday = await rules.escalateFor(db(), ORG, await chicago("2026-10-06 11:00"));
    expect(tuesday).toEqual([{ taskId: task.id, ruleId: working.id }]);
    // Once.
    expect(await rules.escalateFor(db(), ORG, await chicago("2026-10-07 11:00"))).toEqual([]);

    const notices = await noticesFor(CSR);
    expect(notices.map((n) => n.title)).toEqual(["Late: Ring Mrs Patel", "Late: Ring Mrs Patel"]);
    expect(notices[0]!.body).toMatch(/^16 hours past due/);
    expect(notices[1]!.body).toMatch(/^12 working hours past due/);
  });

  it("does not count a holiday, so the task is later by the day the company was shut", async () => {
    await openWeekdays();
    await raw`insert into public.company_holiday (organization_id, name, date, repeats_yearly, closed)
      values (${ORG}, 'Founders Day', '2026-10-05', false, true)`;
    const working = await rules.createRule(owner(), {
      name: "Working", afterHours: 12, workingHours: true, target: "person", targetUserId: CSR,
    });
    const task = await tasks.create(owner(), { title: "Send the PO", dueAt: await chicago("2026-10-02 17:00") });

    expect(await rules.escalateFor(db(), ORG, await chicago("2026-10-06 17:00"))).toEqual([]);
    expect(await rules.escalateFor(db(), ORG, await chicago("2026-10-07 11:00")))
      .toEqual([{ taskId: task.id, ruleId: working.id }]);
  });

  it("can be switched on and off for a rule that exists, and the summary follows", async () => {
    await openWeekdays();
    const rule = await rules.createRule(owner(), { name: "Day", afterHours: 8, target: "role", targetRole: "csr" });
    const on = await rules.updateRule(owner(), { id: rule.id, workingHours: true });
    expect(on).toMatchObject({ workingHours: true, summary: "When a task is 8 working hours late, tell the customer service team." });
    const off = await rules.updateRule(owner(), { id: rule.id, workingHours: false });
    expect(off.workingHours).toBe(false);
    expect((await rules.listRules(owner()))[0]).toMatchObject({ workingHours: false });
  });

  it("is refused in words while no business hours are set, and an old rule can still be turned off", async () => {
    await expect(rules.createRule(owner(), {
      name: "Working", afterHours: 4, workingHours: true, target: "role", targetRole: "csr",
    })).rejects.toThrow(/Set your business hours first/);

    await openWeekdays();
    const rule = await rules.createRule(owner(), { name: "Working", afterHours: 4, workingHours: true, target: "role", targetRole: "csr" });
    await raw`delete from public.business_hours where organization_id = ${ORG}`;
    await expect(rules.updateRule(owner(), { id: rule.id, workingHours: true })).rejects.toThrow(/Set your business hours first/);
    expect((await rules.updateRule(owner(), { id: rule.id, active: false })).active).toBe(false);
  });

  it("when the hours were removed later, still skips holidays and says so on the record", async () => {
    await openWeekdays();
    const rule = await rules.createRule(owner(), { name: "Working", afterHours: 4, workingHours: true, target: "role", targetRole: "csr" });
    await raw`delete from public.business_hours where organization_id = ${ORG}`;
    const task = await tasks.create(owner(), { title: "Chase", dueAt: await chicago("2026-10-05 08:00") });
    expect(await rules.escalateFor(db(), ORG, await chicago("2026-10-05 12:00")))
      .toEqual([{ taskId: task.id, ruleId: rule.id }]);
    const [history] = await rules.escalationsOf(owner(), { taskId: task.id });
    expect(history!.note).toMatch(/business hours are not set/);
  });
});
