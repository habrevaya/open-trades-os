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

/**
 * Only this organization's results.
 *
 * `resumeDue` and `tick` sweep every tenant, because that is their job. A
 * test that asserts on the whole list is asserting on whatever else happens
 * to be running, and it passed for weeks until another suite left a waiting
 * run due at the same moment and the full run went red while the file on its
 * own stayed green.
 */
const ours = <T extends { organizationId: string }>(results: T[]) =>
  results.filter((r) => r.organizationId === ORG);

run("planning", () => {
  it("writes down when a new schedule next fires, without firing it now", async () => {
    /**
     * A workflow saved at noon with "every night at eleven" runs at eleven.
     * Firing on the first tick because there is no row yet would send the
     * nightly summary the moment somebody enabled it, in the middle of the
     * afternoon.
     */
    const id = await defineScheduled({ expression: "0 23 * * *" });

    const [result] = ours(await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") }));
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
    const [result] = ours(await schedule.tick(db(), { now: at("2026-09-24T17:00:00Z") }));

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

    const [result] = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));
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

    const [result] = ours(await schedule.tick(db(), { now: at("2026-09-23T03:59:00Z") }));
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
    const [result] = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));

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
    const [result] = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));

    expect(result!.run!.status).toBe("failed");
    expect(result!.run!.reason).toMatch(/task:write/);
  });
});

run("what the clock leaves alone", () => {
  it("ignores a workflow that is switched off", async () => {
    await defineScheduled({ expression: "* * * * *", enabled: false });
    const results = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));
    expect(results).toHaveLength(0);
  });

  it("ignores a workflow with no published version", async () => {
    // Enabled alone does not mean it runs, which is why `active_version_id`
    // is nullable in the first place.
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await raw`update public.workflow set active_version_id = null where id = ${id}`;
    const results = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));
    expect(results.filter((r) => r.workflowId === id)).toHaveLength(0);
  });

  it("ignores an event-triggered workflow", async () => {
    // The clock and the log are different doors. A workflow that subscribes
    // to job.completed must not also fire nightly because somebody left a
    // schedule in the column.
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await raw`update public.workflow set trigger_kind = 'event' where id = ${id}`;
    const results = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));
    expect(results.filter((r) => r.workflowId === id)).toHaveLength(0);
  });

  it("stops firing a workflow that was deleted", async () => {
    const id = await defineScheduled({ expression: "0 23 * * *" });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await raw`update public.workflow set deleted_at = now() where id = ${id}`;
    const results = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));
    expect(results.filter((r) => r.workflowId === id)).toHaveLength(0);
  });
});

run("waiting, mid run", () => {
  /**
   * "Wait three days, then chase" is what most of the automations a
   * contractor actually wants look like. The naive version is `setTimeout`,
   * which does not survive a deploy, and the symptom is the quietest
   * possible one: the chase never happens and nothing records that it was
   * supposed to.
   */
  /**
   * The two tasks name different entities on purpose. `create_task` is
   * idempotent on (run, entity), which is what stops a workflow firing every
   * hour from raising the same "chase this estimate" task every hour, and
   * two steps in one run with the same entity are a duplicate by that rule.
   */
  const CHASE = [
    {
      kind: "create_task",
      config: { title: "Before", queue: "office", entityType: "job", entityId: fixtureId("ws:e1") },
    },
    { kind: "wait", config: { days: 3 } },
    {
      kind: "create_task",
      config: { title: "After", queue: "office", entityType: "job", entityId: fixtureId("ws:e2") },
    },
  ];

  async function titles() {
    const rows = await raw<{ title: string }[]>`
      select title from public.task where organization_id = ${ORG} order by created_at`;
    return rows.map((r) => r.title);
  }

  async function runRow(workflowId: string) {
    const [row] = await raw<{
      status: string; resume_at: Date | null; resume_step_index: number | null;
    }[]>`select status, resume_at, resume_step_index from public.workflow_run
         where workflow_id = ${workflowId}`;
    return row!;
  }

  it("parks the run rather than finishing it, and does the rest later", async () => {
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    const [fired] = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));

    expect(fired!.run!.status).toBe("waiting");
    expect(await titles()).toEqual(["Before"]);

    const parked = await runRow(id);
    expect(parked.status).toBe("waiting");
    expect(parked.resume_step_index).toBe(2);
    // Three days from when the wait ran, not from when the run started.
    expect(parked.resume_at!.toISOString().slice(0, 10)).toBe("2026-09-26");

    // A pass before it is due does nothing.
    await raw`update public.workflow_run set resume_at = now() + interval '1 hour'
              where workflow_id = ${id}`;
    expect(ours(await schedule.resumeDue(db()))).toHaveLength(0);
    expect(await titles()).toEqual(["Before"]);

    // And then it is due.
    await raw`update public.workflow_run set resume_at = now() - interval '1 minute'
              where workflow_id = ${id}`;
    const [resumed] = ours(await schedule.resumeDue(db()));
    expect(resumed!.run.status).toBe("succeeded");
    expect(await titles()).toEqual(["Before", "After"]);
  });

  it("measures a wait from when it was DUE, not from when it caught up", async () => {
    /**
     * THE BUG THIS TEST EXISTS FOR, AND WHY THE ONE ABOVE MISSED IT.
     *
     * `waitStep` takes a clock and the runner never gave it one, so every
     * wait was computed from `new Date()` at the moment the process got to
     * it. On a healthy schedule that is indistinguishable from correct; on
     * a catch-up after an outage it is not. A Tuesday schedule that runs on
     * Thursday would chase three days from Thursday, so "chase them three
     * days after the estimate" lands five days after it, and nothing
     * anywhere says so.
     *
     * The test above asserted a real date and therefore passed only on the
     * day its fixtures happened to be near. This one fires at a time a
     * fortnight in the past and asserts the offset, so it cannot pass by
     * coincidence on any day.
     */
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });

    const DUE = "2026-09-09T04:00:00Z";
    await schedule.tick(db(), { now: at("2026-09-08T17:00:00Z") });
    const [fired] = ours(await schedule.tick(db(), { now: at(DUE) }));
    expect(fired!.run!.status).toBe("waiting");

    const parked = await runRow(id);
    const waited = parked.resume_at!.getTime() - Date.parse(DUE);
    /**
     * Exactly three days after the scheduled fire. Measured as an offset
     * rather than against a literal date, because a literal date in a test
     * about clocks is how the original defect survived.
     */
    expect(waited).toBe(3 * 86_400_000);

    /** And a fortnight in the past, which wall time could not have produced. */
    expect(parked.resume_at!.getTime()).toBeLessThan(Date.now());
  });

  it("does not repeat the steps it already did", async () => {
    /**
     * The failure that would make a wait worse than useless: a run that sent
     * the text and then waited three days sending it again on the way back.
     * The step rows say what happened, and a resume skips what succeeded.
     */
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    await raw`update public.workflow_run set resume_at = now() - interval '1 minute'
              where workflow_id = ${id}`;
    await schedule.resumeDue(db());

    expect(await titles()).toEqual(["Before", "After"]);
    const steps = await raw`select step_index from public.workflow_step_run
                            where organization_id = ${ORG}`;
    // Three steps, three rows. A replay would have made four.
    expect(steps).toHaveLength(3);
  });

  it("resumes once when two workers see the same run due", async () => {
    // The steps after a wait are the ones that message the customer, so this
    // matters more here than almost anywhere else.
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });
    await raw`update public.workflow_run set resume_at = now() - interval '1 minute'
              where workflow_id = ${id}`;

    const both = await Promise.all([schedule.resumeDue(db()), schedule.resumeDue(db())]);
    const statuses = ours(both.flat()).map((r) => r.run.status);
    expect(statuses.filter((s) => s === "succeeded")).toHaveLength(1);
    /**
     * And the loser stood down rather than crashing.
     *
     * Without the claim both would carry on into step two, and the second
     * would die on the unique index over (run, step). The run still ends up
     * looking right from the outside, which is why the first version of this
     * test passed with the claim removed: the failure is only visible as a
     * status nobody asserted on.
     */
    expect(statuses.filter((s) => s === "failed")).toHaveLength(0);
    expect(await titles()).toEqual(["Before", "After"]);
    expect((await runRow(id)).status).toBe("succeeded");
  });

  it("stands down on a run somebody else already took", async () => {
    /**
     * The claim, on its own. Two workers both resuming means the steps after
     * a wait run twice, and those are the ones that message the customer.
     *
     * Driven by setting the status rather than by racing two calls, because
     * a race is only a test when it loses. An earlier version raced two
     * passes, never overlapped, and passed with the claim removed.
     */
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });

    const [run] = await raw<{ id: string }[]>`
      select id from public.workflow_run where workflow_id = ${id}`;
    await raw`update public.workflow_run
              set status = 'running', resume_at = now() - interval '1 minute'
              where id = ${run!.id}`;

    const result = await schedule.resumeOne(db(), ORG, run!.id);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("claimed_elsewhere");
    expect(await titles()).toEqual(["Before"]);
  });

  it("will not resume a run before its wait is over", async () => {
    /**
     * Asked directly rather than through a pass, because the pass already
     * filters by time in SQL and would answer this whatever the service did.
     * Somebody calling resume by hand, or a future retry path, must get the
     * same no.
     */
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });

    const [run] = await raw<{ id: string }[]>`
      select id from public.workflow_run where workflow_id = ${id}`;
    const result = await schedule.resumeOne(db(), ORG, run!.id, at("2026-09-24T00:00:00Z"));

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not_due");
    expect(await titles()).toEqual(["Before"]);
  });

  it("skips the steps that already succeeded, even with nothing to say where to start", async () => {
    /**
     * `resume_step_index` is where to start; the step rows are what actually
     * happened. A run whose index is missing, from an older row or a crash
     * between the two updates, must still not send the message it already
     * sent. Belt and braces, and untested until a deliberate break showed
     * the index alone was carrying the whole thing.
     */
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });

    await raw`update public.workflow_run
              set resume_at = now() - interval '1 minute', resume_step_index = null
              where workflow_id = ${id}`;
    const [resumed] = ours(await schedule.resumeDue(db()));

    expect(resumed!.run.status).toBe("succeeded");
    expect(await titles()).toEqual(["Before", "After"]);
    // Three steps, three rows. A replay would have died on the unique index.
    expect(await raw`select step_index from public.workflow_step_run
                     where organization_id = ${ORG}`).toHaveLength(3);
  });

  it("finishes on the version it started on, not the one it was edited into", async () => {
    /**
     * A workflow edited during a three day wait must finish the run it began.
     * Resuming into new steps would mean a customer receiving something from
     * a definition that did not exist when the run started, and whose
     * permissions were never approved against it.
     */
    const id = await defineScheduled({ expression: "0 23 * * *", steps: CHASE });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") });

    const v2 = fixtureId(`ws:v2:${Math.random()}`);
    await raw`insert into public.workflow_version
                (id, organization_id, workflow_id, version, conditions, steps, required_permissions, published_at)
              values (${v2}, ${ORG}, ${id}, 2, ${json({})},
                      ${json([{ kind: "create_task", config: { title: "Edited", queue: "office" } }])},
                      ${json(["task:write"])}, now())`;
    await raw`update public.workflow set active_version_id = ${v2} where id = ${id}`;

    await raw`update public.workflow_run set resume_at = now() - interval '1 minute'
              where workflow_id = ${id}`;
    await schedule.resumeDue(db());

    expect(await titles()).toEqual(["Before", "After"]);
  });

  it("refuses a wait it cannot read rather than skipping it", async () => {
    /**
     * A wait that quietly becomes zero turns "chase in three days" into
     * "chase immediately", which is a text the customer gets one minute
     * after the first one.
     */
    const id = await defineScheduled({
      expression: "0 23 * * *",
      steps: [{ kind: "wait", config: { days: "three" } }],
    });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    const [fired] = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));

    expect(fired!.run!.status).toBe("failed");
    expect(fired!.run!.reason).toMatch(/must be a number/);
    expect((await runRow(id)).status).toBe("failed");
  });

  it("does not park for a wait that is already over", async () => {
    // "Wait until the appointment" on a job booked for this morning is an
    // ordinary case, and parking the run would cost a tick and a claim to
    // achieve nothing.
    await defineScheduled({
      expression: "0 23 * * *",
      steps: [
        { kind: "wait", config: { until: "2020-01-01T00:00:00Z" } },
        { kind: "create_task", config: { title: "Straight through", queue: "office" } },
      ],
    });
    await schedule.tick(db(), { now: at("2026-09-22T17:00:00Z") });
    const [fired] = ours(await schedule.tick(db(), { now: at("2026-09-23T04:00:30Z") }));

    expect(fired!.run!.status).toBe("succeeded");
    expect(await titles()).toEqual(["Straight through"]);
  });
});
