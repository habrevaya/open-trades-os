import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor, type field } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as dispatchSvc from "../src/services/dispatch";
import * as tasks from "../src/services/tasks";
import * as checklist from "../src/services/task-checklist";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A TASK WITH A CHECKLIST, TICKED AND FINISHED FROM THE PHONE'S QUEUE
 *
 * The technician's own task shows its items in the day, ticks them one at a
 * time with no signal, and finishes with the reason the office's page asks for.
 * Through the real sync and the real services: the rules that matter (ticking is
 * for your own task; a tick that arrives late does not undo a later one; a
 * closed task refuses a tick in words; done with items unticked needs a reason)
 * live where they meet.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ftc:org");
const OWNER = fixtureId("ftc:owner");
const RAY = fixtureId("ftc:ray");
const SAM = fixtureId("ftc:sam");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const tech = (userId: string, technicianId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId }, db: db(),
});
let rayTech = "";
const ray = () => tech(RAY, rayTech);

async function technician(userId: string, name: string): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@ftc.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Task Checklist Co", slug: "task-checklist-co" });
  rayTech = await technician(RAY, "Ray Nunez");
  await technician(SAM, "Sam Ortiz");
});
afterAll(async () => { if (raw) await raw.end(); });

async function send(ctx: ServiceContext, ops: Array<{ kind: field.OperationKind; subjectId: string; payload?: Record<string, unknown>; occurredAt?: Date }>) {
  const device = await fieldOps.register(ctx, { installationId: `ftc-${crypto.randomUUID()}` });
  const result = await fieldOps.sync(ctx, {
    deviceId: device.deviceId,
    operations: ops.map((op, i) => ({
      clientId: crypto.randomUUID(), sequence: i + 1, kind: op.kind, subjectId: op.subjectId,
      occurredAt: (op.occurredAt ?? new Date(Date.now() - (ops.length - i) * 60_000)).toISOString(),
      payload: op.payload ?? {},
    })),
  });
  return result.results;
}

async function vanCheck(assignee: string = RAY) {
  const task = await tasks.create(owner(), { title: "Van check", assigneeUserId: assignee, checklist: ["Tyres", "Fluids", "Lights"] });
  const list = await checklist.list(owner(), { taskId: task.id });
  return { taskId: task.id, items: list.items.map((i) => i.id) };
}

run("a task with a checklist on the phone", () => {
  it("comes with its items in the day, in order", async () => {
    const { taskId } = await vanCheck();
    const device = await fieldOps.register(ray(), { installationId: `day-${crypto.randomUUID()}` });
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 1 });
    const task = day.tasks.find((t) => t.id === taskId)!;
    expect(task.checklist.map((i) => [i.label, i.done])).toEqual([["Tyres", false], ["Fluids", false], ["Lights", false]]);
    expect(task).toMatchObject({ checklistTotal: 3, checklistDone: 0, mine: true });
  });

  it("changes the day's revision when an item is ticked, so the phone fetches it", async () => {
    const { taskId, items } = await vanCheck();
    const device = await fieldOps.register(ray(), { installationId: `rev-${crypto.randomUUID()}` });
    const first = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 1 });
    await checklist.tick(owner(), { taskId, itemId: items[0]!, done: true });
    const second = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 1, sinceRevision: first.revision });
    expect(second.unchanged).toBe(false);
  });

  it("ticks items one at a time, each saying who and when it was done on the phone", async () => {
    const { taskId, items } = await vanCheck();
    const at = new Date(Date.now() - 3 * 3600_000);
    const results = await send(ray(), [
      { kind: "task.tick", subjectId: taskId, payload: { itemId: items[0], done: true }, occurredAt: at },
      { kind: "task.tick", subjectId: taskId, payload: { itemId: items[1], done: true } },
    ]);
    expect(results.map((r) => [r.status, r.rejection])).toEqual([["applied", null], ["applied", null]]);
    const list = await checklist.list(owner(), { taskId });
    expect(list.items.map((i) => [i.label, i.done, i.doneBy])).toEqual([["Tyres", true, "Ray Nunez"], ["Fluids", true, "Ray Nunez"], ["Lights", false, null]]);
    expect(Math.abs(new Date(list.items[0]!.doneAt!).getTime() - at.getTime())).toBeLessThan(1000);
  });

  it("keeps the later tick of one item when they arrive out of order, and never lets one item replace another", async () => {
    const { taskId, items } = await vanCheck();
    const later = new Date(Date.now() - 60_000);
    const earlier = new Date(Date.now() - 600_000);
    await send(ray(), [{ kind: "task.tick", subjectId: taskId, payload: { itemId: items[0], done: false }, occurredAt: later }]);
    const results = await send(ray(), [
      { kind: "task.tick", subjectId: taskId, payload: { itemId: items[0], done: true }, occurredAt: earlier },
      { kind: "task.tick", subjectId: taskId, payload: { itemId: items[2], done: true }, occurredAt: earlier },
    ]);
    expect(results.map((r) => r.status)).toEqual(["superseded", "applied"]);
    const list = await checklist.list(owner(), { taskId });
    expect(list.items.map((i) => i.done)).toEqual([false, false, true]);
  });

  it("refuses ticking somebody else's task, in words", async () => {
    const { taskId, items } = await vanCheck(SAM);
    const [result] = await send(ray(), [{ kind: "task.tick", subjectId: taskId, payload: { itemId: items[0], done: true } }]);
    expect(result!.status).toBe("rejected");
    expect(result!.rejection).toMatch(/may not|permission|Your account/i);
    expect((await checklist.list(owner(), { taskId })).items.every((i) => !i.done)).toBe(true);
  });

  it("refuses a tick on a task finished meanwhile", async () => {
    const { taskId, items } = await vanCheck();
    await tasks.close(owner(), { id: taskId, overrideReason: "Not needed" });
    const [result] = await send(ray(), [{ kind: "task.tick", subjectId: taskId, payload: { itemId: items[0], done: true } }]);
    expect(result!.status).toBe("rejected");
    expect(result!.rejection).toMatch(/is closed/);
  });

  it("finishes done only when ticked, or with a reason kept apart from the outcome", async () => {
    const { taskId, items } = await vanCheck();
    const [refused] = await send(ray(), [
      { kind: "task.tick", subjectId: taskId, payload: { itemId: items[0], done: true } },
    ]);
    expect(refused!.status).toBe("applied");
    const [open] = await send(ray(), [{ kind: "task.close", subjectId: taskId, payload: { outcome: "Done" } }]);
    expect(open!.status).toBe("rejected");
    expect(open!.rejection).toMatch(/2 items are not ticked/);

    const [closed] = await send(ray(), [
      { kind: "task.close", subjectId: taskId, payload: { outcome: "Van fine", overrideReason: "Gauge missing, fluids not checked" } },
    ]);
    expect(closed!.status).toBe("applied");
    const [row] = await raw`select status, outcome, checklist_override_reason from public.task where id = ${taskId}`;
    expect(row).toMatchObject({ status: "done", outcome: "Van fine", checklist_override_reason: "Gauge missing, fluids not checked" });
  });

  it("finishes with nothing to say once everything is ticked", async () => {
    const { taskId, items } = await vanCheck();
    const results = await send(ray(), [
      ...items.map((itemId) => ({ kind: "task.tick" as const, subjectId: taskId, payload: { itemId, done: true } })),
      { kind: "task.close", subjectId: taskId, payload: {} },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied", "applied", "applied"]);
  });
});
