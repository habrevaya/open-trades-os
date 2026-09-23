import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import * as schedule from "../src/services/workflow-schedule";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CLOCK, AGAINST A REAL DATABASE
 *
 * `trigger_kind` has had `schedule` in it since the first migration and
 * nothing fired one: a contractor could set a workflow to run every night,
 * see it saved and enabled, and never learn that it did not run. This is the
 * path that makes it true.
 *
 * Three things have to hold and each one is a way to lose money or trust:
 *
 *   ONCE       Two workers seeing the same row due must not both fire it.
 *   ON TIME    In the COMPANY's timezone. Eleven at night in Austin is five
 *              in the morning in UTC, and a nightly summary arriving at five
 *              in the morning is a support call.
 *   HONEST     A schedule nobody can read is recorded as an error on the row
 *              rather than quietly becoming "never".
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ws:org");
const USER = fixtureId("ws:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Clock Co", slug: "clock-co" });
  // Austin, explicitly. Every assertion below is a different instant in UTC.
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_schedule where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
});

const json = (value: unknown) => raw.json(value as never);

async function defineScheduled(opts: {
  expression: string;
  enabled?: boolean;
  steps?: Record<string, unknown>[];
  conditions?: Record<string, unknown>;
  permissions?: string[];
}) {
  const workflowId = fixtureId(`ws:w:${Math.random()}`);
  const versionId = fixtureId(`ws:v:${Math.random()}`);
  await raw`insert into public.workflow
              (id, organization_id, name, enabled, trigger_kind, trigger_events, schedule)
            values (${workflowId}, ${ORG}, 'Nightly', ${opts.enabled ?? true}, 'schedule',
                    ${json([])}, ${opts.expression})`;
  await raw`insert into public.workflow_version
              (id, organization_id, workflow_id, version, conditions, steps, required_permissions, published_at)
            values (${versionId}, ${ORG}, ${workflowId}, 1,
                    ${json(opts.conditions ?? {})},
                    ${json(opts.steps ?? [{
                      kind: "create_task",
                      config: { title: "Nightly sweep", queue: "office" },
                    }])},
                    ${json(opts.permissions ?? ["task:write"])}, now())`;
  await raw`update public.workflow set active_version_id = ${versionId} where id = ${workflowId}`;
  return workflowId;
}

/** The scheduler's own view of a workflow. */
async function stateOf(workflowId: string) {
  const [row] = await raw<{
    next_run_at: Date | null; last_run_at: Date | null;
    expression: string; last_error: string | null;
  }[]>`select next_run_at, last_run_at, expression, last_error
       from public.workflow_schedule where workflow_id = ${workflowId}`;
  return row ?? null;
}

/** What `app.scheduled_workflows` would hand the tick for this workflow. */
async function dueRow(workflowId: string) {
  const rows = await raw`select * from app.scheduled_workflows(200)`;
  const row = rows.find((r) => r["workflow_id"] === workflowId);
  if (!row) throw new Error("workflow is not in the schedulable set");
  return row as never;
}

const at = (iso: string) => new Date(iso);

run("planning", () => {
  it("writes down when a new schedule next fires, without firing it now", async () => {
    /**
     * A workflow saved at noon with "every night at eleven" runs at eleven.
     * Firing on the first tick because there is no row yet would send the
     * nightly summary the moment somebody enabled it, in the middle of the
     * afternoon.
     */
    const id = await defineScheduled({ expression: "0 23 * * *" });

    const [result] = await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    expect(result!.action).toBe("planned");

    const state = await stateOf(id);
    // Eleven at night in Austin is four in the morning in UTC the next day.
    expect(state!.next_run_at!.toISOString()).toBe("2026-09-23T04:00:00.000Z");
    expect(state!.last_run_at).toBeNull();
  });

  it("replans rather than firing when the expression changes", async () => {
    /**
     * Editing "every night at eleven" into "every Monday" must not fire once
     * more on the old clock. The stored expression is what makes that
     * detectable without reading the workflow on every tick.
     */
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });

    await raw`update public.workflow set schedule = '0 9 * * 1' where id = ${id}`;
    // Long past the old due time, so a tick that ignored the change would fire.
    const [result] = await schedule.tick(db(), { now: at("2026-09-24T17:00:00Z") });

    expect(result!.action).toBe("planned");
    const state = await stateOf(id);
    expect(state!.expression).toBe("0 9 * * 1");
    expect(state!.last_run_at).toBeNull();
    // Monday 28 September, nine in the morning in Austin.
    expect(state!.next_run_at!.toISOString()).toBe("2026-09-28T14:00:00.000Z");
  });

  it("records a schedule nobody can read rather than treating it as never", async () => {
    /**
     * A workflow that silently stops running is the automation failure nobody
     * notices until a customer does. The reason goes on the row, where the
     * screen that lists workflows can show it.
     */
    const id = await defineScheduled({ expression: "every tuesday plz" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });

    const state = await stateOf(id);
    expect(state!.next_run_at).toBeNull();
    expect(state!.last_error).toMatch(/five fields/);
  });
});

run("firing", () => {
  it("runs the workflow when its time comes, and moves to the next", async () => {
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });

    const [result] = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    expect(result!.action).toBe("fired");
    expect(result!.run!.status).toBe("succeeded");

    const [task] = await raw`select title, queue from public.task where organization_id = ${ORG}`;
    expect(task!["title"]).toBe("Nightly sweep");

    const state = await stateOf(id);
    expect(state!.last_run_at!.toISOString()).toBe("2026-09-23T04:00:00.000Z");
    expect(state!.next_run_at!.toISOString()).toBe("2026-09-24T04:00:00.000Z");
  });

  it("does not fire before its time", async () => {
    await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });

    const [result] = await schedule.tick(db(), { now: at("2026-09-23T03:59:00Z") });
    expect(result!.action).toBe("skipped");
    expect(result!.reason).toBe("not_due");
    const tasks = await raw`select id from public.task where organization_id = ${ORG}`;
    expect(tasks).toHaveLength(0);
  });

  it("fires once when two workers see the same row due", async () => {
    /**
     * THE ONE THAT MATTERS. A scheduled workflow sends texts; two workers
     * both firing it is a duplicate message to every customer, which is the
     * kind of incident that ends a trial.
     *
     * The claim is a conditional update on the due time, so of two ticks that
     * both read this row as due exactly one proceeds.
     */
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });

    const now = at("2026-09-23T04:00:30Z");
    const row = await dueRow(id);
    const both = await Promise.all([
      schedule.tickOne(db(), row, now),
      schedule.tickOne(db(), row, now),
    ]);

    expect(both.filter((r) => r.action === "fired")).toHaveLength(1);
    expect(both.filter((r) => r.reason === "claimed_elsewhere")).toHaveLength(1);
    const tasks = await raw`select id from public.task where organization_id = ${ORG}`;
    expect(tasks).toHaveLength(1);
  });

  it("records the firing in the event log, for the occurrence it was for", async () => {
    /**
     * "Why did this go out at eleven on Tuesday" is answerable from the same
     * place as every other why. `scheduledFor` is the due time rather than
     * the moment the tick happened to run, so a worker that was down for an
     * hour records the occurrence rather than its own lateness.
     */
    await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T05:30:00Z") });

    const [event] = await raw<{ name: string; payload: Record<string, unknown> }[]>`
      select name, payload from public.domain_event where organization_id = ${ORG}`;
    expect(event!.name).toBe("workflow.scheduled");
    expect(event!.payload["scheduledFor"]).toBe("2026-09-23T04:00:00.000Z");
  });

  it("catches up with one run rather than one per missed occurrence", async () => {
    /**
     * A worker down for three days comes back to a schedule three days late.
     * Firing once for each missed night would send three summaries at once,
     * which is worse than missing them: the customer sees the outage.
     */
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-26T12:00:00Z") });

    const tasks = await raw`select id from public.task where organization_id = ${ORG}`;
    expect(tasks).toHaveLength(1);
    // And back on the normal clock rather than still three days behind.
    const state = await stateOf(id);
    expect(state!.next_run_at!.toISOString()).toBe("2026-09-27T04:00:00.000Z");
  });

  it("respects the conditions on the version", async () => {
    /**
     * "Every morning at nine, IF there is anything to chase" is the normal
     * shape of a scheduled workflow. A schedule that ignored its conditions
     * would send an empty summary every day.
     */
    await defineScheduled({
      expression: "0 23 * * *",
      conditions: { all: [{ path: "workflowId", op: "eq", value: "not-this-one" }] },
    });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    const [result] = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });

    expect(result!.action).toBe("fired");
    expect(result!.run!.status).toBe("skipped");
    expect(result!.run!.reason).toBe("conditions");
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(0);
  });

  it("runs with the permissions the version declared and no others", async () => {
    /**
     * The same rule as an event-triggered run. A scheduled workflow is not a
     * more trusted one for having been set up by an owner: it acts with what
     * its version declared, checked at run time rather than trusted from
     * publish time.
     */
    await defineScheduled({ expression: "0 23 * * *", permissions: ["message:send"] });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    const [result] = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });

    expect(result!.run!.status).toBe("failed");
    expect(result!.run!.reason).toMatch(/task:write/);
  });
});

run("what the clock leaves alone", () => {
  it("ignores a workflow that is switched off", async () => {
    await defineScheduled({ expression: "* * * * *", enabled: false });
    const results = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    expect(results.filter((r) => r.organizationId === ORG)).toHaveLength(0);
  });

  it("ignores a workflow with no published version", async () => {
    // Enabled alone does not mean it runs, which is why `active_version_id`
    // is nullable in the first place.
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await raw`update public.workflow set active_version_id = null where id = ${id}`;
    const results = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    expect(results.filter((r) => r.workflowId === id)).toHaveLength(0);
  });

  it("ignores an event-triggered workflow", async () => {
    // The clock and the log are different doors. A workflow that subscribes
    // to job.completed must not also fire nightly because somebody left a
    // schedule in the column.
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await raw`update public.workflow set trigger_kind = 'event' where id = ${id}`;
    const results = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    expect(results.filter((r) => r.workflowId === id)).toHaveLength(0);
  });

  it("stops firing a workflow that was deleted", async () => {
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await raw`update public.workflow set deleted_at = now() where id = ${id}`;
    const results = await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    expect(results.filter((r) => r.workflowId === id)).toHaveLength(0);
  });
});
