import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as tasks from "../src/services/tasks";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE OFFICE WORK QUEUE
 *
 * The work that is not a job, and where the money quietly leaks: an
 * unapproved estimate nobody followed up is a sale that did not happen and
 * leaves no record that it existed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tk:org");
const USER = fixtureId("tk:user");
const OTHER = fixtureId("tk:other");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const colleague = (): ServiceContext => ({
  actor: { userId: OTHER, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db(),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Task Co", slug: "task-co" });
  await raw`delete from public."user" where id = ${OTHER}`;
  await raw`insert into public."user" (id, email) values (${OTHER}, 'other@task-co.test')`;
  await raw`insert into public.membership (organization_id, user_id, role)
            values (${ORG}, ${OTHER}, 'office_manager')`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.task where organization_id = ${ORG}`;
});

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

run("the queue", () => {
  it("shows unassigned work in my list", async () => {
    /**
     * A "my tasks" list that hides unclaimed work means the unclaimed work is
     * nobody's, which is how a queue silently becomes a backlog.
     */
    await tasks.create(owner(), { title: "Chase the Whitfield approval" });
    const mine = await tasks.list(colleague(), { view: "mine" });
    expect(mine.data.map((t) => t.title)).toContain("Chase the Whitfield approval");
  });

  it("sorts the soonest due first and undated work last", async () => {
    // A null sorts before everything by default, which would put the undated
    // work above the thing that is late today.
    await tasks.create(owner(), { title: "No date" });
    await tasks.create(owner(), { title: "Tomorrow", dueAt: hoursFromNow(24) });
    await tasks.create(owner(), { title: "In an hour", dueAt: hoursFromNow(1) });

    const mine = await tasks.list(owner(), { view: "mine" });
    expect(mine.data.map((t) => t.title)).toEqual(["In an hour", "Tomorrow", "No date"]);
  });

  it("works out overdue from the clock rather than a stored flag", async () => {
    // A task marked overdue by a nightly job is quietly not overdue whenever
    // that job fails.
    await tasks.create(owner(), { title: "Late", dueAt: hoursFromNow(-3) });
    await tasks.create(owner(), { title: "Fine", dueAt: hoursFromNow(3) });

    const late = await tasks.list(owner(), { view: "overdue" });
    expect(late.data.map((t) => t.title)).toEqual(["Late"]);
    expect(late.data[0]!.overdue).toBe(true);
  });

  it("keeps finished work out of the queue", async () => {
    const open = await tasks.create(owner(), { title: "Do it" });
    await tasks.close(owner(), { id: open.id });
    expect((await tasks.list(owner(), { view: "mine" })).data).toHaveLength(0);
    // Still there, because a queue that deletes its history cannot report.
    expect((await tasks.list(owner(), { view: "all" })).data).toHaveLength(1);
  });

  it("counts what the navigation badge needs", async () => {
    await tasks.create(owner(), { title: "Mine", assigneeUserId: USER });
    await tasks.create(owner(), { title: "Late", dueAt: hoursFromNow(-1) });
    const counts = await tasks.counts(owner());
    expect(counts.mine).toBe(2);
    expect(counts.overdue).toBe(1);
  });
});

run("closing one", () => {
  it("records who finished it and when", async () => {
    const task = await tasks.create(owner(), { title: "Call them back" });
    const done = await tasks.close(colleague(), { id: task.id, outcome: "Spoke to them" });
    expect(done.status).toBe("done");
    expect(done.completedByUserId).toBe(OTHER);
    expect(done.completedAt).not.toBeNull();
  });

  it("keeps dismissed separate from done", async () => {
    /**
     * "We decided not to" and "we did it" are different facts. A queue where
     * the second quietly absorbs the first tells an owner nothing about how
     * much of the raised work was worth raising.
     */
    const task = await tasks.create(owner(), { title: "Upsell the filter" });
    const out = await tasks.close(owner(), { id: task.id, dismissed: true, outcome: "They just replaced it" });
    expect(out.status).toBe("dismissed");
  });

  it("refuses a dismissal with no reason", async () => {
    // Otherwise it is indistinguishable from somebody deleting a task to make
    // their queue look shorter.
    const task = await tasks.create(owner(), { title: "Something" });
    await expect(tasks.close(owner(), { id: task.id, dismissed: true }))
      .rejects.toThrow(/why/);
  });

  it("refuses to close the same task twice", async () => {
    const task = await tasks.create(owner(), { title: "Once" });
    await tasks.close(owner(), { id: task.id });
    await expect(tasks.close(owner(), { id: task.id })).rejects.toThrow(/already closed/);
  });
});

run("claiming", () => {
  it("lets exactly one person take an unassigned task", async () => {
    // Two people opening the queue at the same moment must not both do the
    // work. The claim is a conditional update, so Postgres serialises them.
    const task = await tasks.create(owner(), { title: "Whoever gets there first" });
    await expect(tasks.claim(owner(), { id: task.id })).resolves.toBeTruthy();
    await expect(tasks.claim(colleague(), { id: task.id })).rejects.toThrow(/Somebody else/);
  });

  it("is the one write a technician is trusted with", async () => {
    /**
     * A technician can be handed a task and complete it. Letting them create
     * work for other people is a different thing, and a queue anybody can add
     * to stops being a queue anybody reads.
     */
    const task = await tasks.create(owner(), { title: "Drop the part off" });
    const technician: ServiceContext = {
      actor: { userId: OTHER, organizationId: ORG, roles: ["technician"] as Actor["roles"] },
      db: db(),
    };
    await expect(tasks.claim(technician, { id: task.id })).resolves.toBeTruthy();
    await expect(tasks.create(technician, { title: "Somebody else do this" }))
      .rejects.toThrow(/task:write/);
  });
});

run("raised by an automation", () => {
  const raiseTwice = async (runId: string, entityId: string) =>
    inTenant(owner(), async (tx) => {
      const first = await tasks.raise(tx, ORG, runId, {
        title: "Chase this estimate", entityType: "estimate", entityId,
      });
      const second = await tasks.raise(tx, ORG, runId, {
        title: "Chase this estimate", entityType: "estimate", entityId,
      });
      return { first, second };
    });

  it("does not raise the same task twice", async () => {
    /**
     * A workflow firing on every event would otherwise raise the same task
     * every hour until somebody turns the automation off, which is how a
     * queue becomes something people stop opening.
     */
    const runId = await seedRun();
    const { first, second } = await raiseTwice(runId, fixtureId("tk:est"));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect((await tasks.list(owner(), { view: "all" })).data).toHaveLength(1);
  });

  it("records the run, so why is this in my queue has an answer", async () => {
    const runId = await seedRun();
    await raiseTwice(runId, fixtureId("tk:est2"));
    const [row] = await raw<{ raised_by_run_id: string | null }[]>`
      select raised_by_run_id from public.task where organization_id = ${ORG}`;
    expect(row!.raised_by_run_id).toBe(runId);
  });
});

/** A workflow run for a task to point at. */
async function seedRun(): Promise<string> {
  const workflowId = fixtureId(`tk:w:${Math.random()}`);
  const versionId = fixtureId(`tk:v:${Math.random()}`);
  const runId = fixtureId(`tk:r:${Math.random()}`);
  await raw`insert into public.workflow (id, organization_id, name, trigger_kind, trigger_events)
            values (${workflowId}, ${ORG}, 'Chase', 'event', ${raw.json(["estimate.sent"])})`;
  await raw`insert into public.workflow_version
              (id, organization_id, workflow_id, version, conditions, steps, required_permissions)
            values (${versionId}, ${ORG}, ${workflowId}, 1, ${raw.json({})}, ${raw.json([])},
                    ${raw.json(["task:write"])})`;
  await raw`insert into public.workflow_run
              (id, organization_id, workflow_id, version_id, idempotency_key, status)
            values (${runId}, ${ORG}, ${workflowId}, ${versionId}, ${`k${Math.random()}`}, 'succeeded')`;
  return runId;
}
