import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as schedules from "../src/services/delivery-schedules";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * "SEND IT NOW" ON A SCHEDULED REPORT
 *
 * The same delivery a scheduled occurrence makes, now, without moving the
 * clock: so the Monday report still goes on Monday, and the person who
 * pressed it, not whoever set the schedule up, is whose run it was.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("send-now:org");
const OWNER = fixtureId("send-now:owner");
const ADMIN = fixtureId("send-now:admin");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"], idempotencyKey?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(), ...(idempotencyKey ? { idempotencyKey } : {}),
});

let scheduleId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Send Now Co", slug: "send-now-co" });
  await raw`delete from public."user" where id = ${ADMIN} or email = 'send-now-admin@test.local'`;
  await raw`insert into public."user" (id, email, name) values (${ADMIN}, 'send-now-admin@test.local', 'Ada Admin')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${ADMIN}, 'admin')`;
  const schedule = await schedules.createReportSchedule(as(OWNER, ["owner"]), {
    builtIn: "jobs-by-status", frequency: "weekly", weekdays: [1], time: "07:00",
    userIds: [OWNER], addresses: ["books@accountant.test"],
  });
  scheduleId = schedule.id;
});

afterAll(async () => { if (raw) await raw.end(); });

const deliveries = () => raw<{ idempotency_key: string; ran_as_user_id: string | null; status: string }[]>`
  select idempotency_key, ran_as_user_id, status from public.report_delivery
  where organization_id = ${ORG} and schedule_id = ${scheduleId} order by created_at`;

run("sending a scheduled report now", () => {
  it("delivers it to the same people, as the person pressing it, and leaves the clock alone", async () => {
    const [before] = await raw`select next_run_at from public.delivery_schedule where id = ${scheduleId}`;
    const sent = await schedules.sendReportScheduleNow(as(ADMIN, ["admin"]), { id: scheduleId });
    expect(sent.scheduleId).toBe(scheduleId);
    expect(sent.recipients.map((r) => r.address).sort()).toEqual(["books@accountant.test", "send-now-co@test.local"]);

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotency_key).toMatch(new RegExp(`^schedule:${scheduleId}:now:`));
    expect(rows[0]!.ran_as_user_id).toBe(ADMIN);

    const [after] = await raw`select next_run_at from public.delivery_schedule where id = ${scheduleId}`;
    expect(after!.next_run_at).toEqual(before!.next_run_at);
    const [audit] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'report_schedule.sent_now'`;
    expect(audit!.n).toBe(1);
  });

  it("sends once per press, and a retried request with the same key sends nothing new", async () => {
    await schedules.sendReportScheduleNow(as(OWNER, ["owner"], "press-1"), { id: scheduleId });
    const replay = await schedules.sendReportScheduleNow(as(OWNER, ["owner"], "press-1"), { id: scheduleId });
    expect(replay.scheduleId).toBe(scheduleId);
    expect(await deliveries()).toHaveLength(2);
    await schedules.sendReportScheduleNow(as(OWNER, ["owner"]), { id: scheduleId });
    expect(await deliveries()).toHaveLength(3);
  });

  it("still sends a paused schedule by hand, because pausing is about the clock", async () => {
    await schedules.setReportSchedulePaused(as(OWNER, ["owner"]), { id: scheduleId, paused: true });
    await schedules.sendReportScheduleNow(as(OWNER, ["owner"]), { id: scheduleId });
    expect(await deliveries()).toHaveLength(4);
    const [row] = await raw`select next_run_at from public.delivery_schedule where id = ${scheduleId}`;
    expect(row!.next_run_at).toBeNull();
  });

  it("refuses somebody who may not build reports, and a schedule that is not there", async () => {
    await expect(schedules.sendReportScheduleNow(as(OWNER, ["dispatcher"]), { id: scheduleId }))
      .rejects.toThrow(PermissionError);
    await expect(schedules.sendReportScheduleNow(as(OWNER, ["owner"]), { id: fixtureId("send-now:nothing") }))
      .rejects.toThrow(NotFoundError);
  });
});
