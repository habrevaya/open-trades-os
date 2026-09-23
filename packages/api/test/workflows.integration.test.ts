import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as workflows from "../src/services/workflows";
import * as schedule from "../src/services/workflow-schedule";
import { type ServiceContext } from "../src/services/context";
import { PermissionError } from "@opentradesos/core";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AUTOMATIONS, AS SOMETHING A PERSON CAN MAKE AND STOP
 *
 * The engine ran for a long time with no way to create a workflow but an
 * insert, and no way to stop one but an update. `canPublish` had been in core
 * since the engine was written, fully tested, and called by nothing: the rule
 * that you cannot grant what you do not hold was enforced by no code path at
 * all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("wfs:org");
const USER = fixtureId("wfs:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Flows Co", slug: "flows-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_schedule where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
});

const TASK_STEP = { kind: "create_task", config: { title: "Chase it", queue: "office" } };

run("making one", () => {
  it("saves it switched off", async () => {
    /**
     * A new automation that started running the moment it was saved would
     * send its first message before anybody had read it back.
     */
    const flow = await workflows.create(owner(), {
      name: "Chase an estimate", triggerKind: "event",
      triggerEvents: ["estimate.sent"], steps: [TASK_STEP],
    });
    expect(flow.enabled).toBe(false);
    expect(flow.activeVersionId).toBeTruthy();
  });

  it("records what the author was allowed to approve", async () => {
    const flow = await workflows.create(owner(), {
      name: "Chase", triggerKind: "event", triggerEvents: ["estimate.sent"],
      steps: [TASK_STEP],
    });
    const [version] = await raw<{ required_permissions: string[] }[]>`
      select required_permissions from public.workflow_version
      where id = ${flow.activeVersionId!}`;
    // The run checks against this again, so it is a record of what was
    // signed off rather than a standing grant.
    expect(version!.required_permissions).toEqual(["task:write"]);
  });

  it("refuses a step the author cannot perform", async () => {
    /**
     * YOU CANNOT GRANT WHAT YOU DO NOT HOLD. A workflow is a container for
     * permissions, so somebody who can write workflows and cannot send
     * messages must not be able to publish one that sends them. `canPublish`
     * enforced this and nothing called it until now.
     */
    const dispatcher = as(["dispatcher"]);
    await expect(workflows.create(dispatcher, {
      name: "Sneaky", triggerKind: "event", triggerEvents: ["invoice.paid"],
      steps: [{ kind: "record_payment", config: {} }],
    })).rejects.toThrow(/payment:collect|workflow:write/);
  });

  it("refuses a step this build has never heard of", async () => {
    // Refused rather than dropped. A definition written against a newer
    // build must not run here with half its steps quietly missing.
    await expect(workflows.create(owner(), {
      name: "Future", triggerKind: "event", triggerEvents: ["job.completed"],
      steps: [{ kind: "launch_missiles" }],
    })).rejects.toThrow(/no step called/);
  });

  it("refuses an event automation with nothing to trigger on", async () => {
    // It would be saved, enabled, and never fire.
    await expect(workflows.create(owner(), {
      name: "Nothing", triggerKind: "event", triggerEvents: [], steps: [TASK_STEP],
    })).rejects.toThrow(/at least one event/);
  });

  it("refuses a schedule nobody can read, at the moment somebody saves it", async () => {
    /**
     * The whole point of checking here. A schedule that silently becomes
     * "never" is the automation failure nobody notices until a customer
     * does, and the moment somebody presses save is the only moment they
     * are looking.
     */
    await expect(workflows.create(owner(), {
      name: "Every tuesday plz", triggerKind: "schedule", schedule: "tuesdays",
      steps: [TASK_STEP],
    })).rejects.toThrow(/five fields/);
  });

  it("refuses one with no steps", async () => {
    await expect(workflows.create(owner(), {
      name: "Empty", triggerKind: "event", triggerEvents: ["job.completed"], steps: [],
    })).rejects.toThrow(/at least one step/);
  });

  it("needs workflow:write, not just workflow:read", async () => {
    // Seeing what is automated and being able to change it are different
    // questions with very different answers.
    const manager = as(["office_manager"]);
    await expect(workflows.create(manager, {
      name: "Nope", triggerKind: "event", triggerEvents: ["job.completed"], steps: [TASK_STEP],
    })).rejects.toThrow(PermissionError);
    await expect(workflows.list(manager)).resolves.toBeTruthy();
  });
});

run("turning one on and off", () => {
  async function scheduled() {
    return workflows.create(owner(), {
      name: "Nightly", triggerKind: "schedule", schedule: "0 23 * * *", steps: [TASK_STEP],
    });
  }

  it("turns on and off", async () => {
    const flow = await scheduled();
    expect((await workflows.setEnabled(owner(), { id: flow.id, enabled: true })).enabled).toBe(true);
    expect((await workflows.setEnabled(owner(), { id: flow.id, enabled: false })).enabled).toBe(false);
  });

  it("refuses to enable one with nothing published", async () => {
    // Enabled with nothing to run does nothing and looks like it does
    // something, which is the worst combination.
    const flow = await scheduled();
    await raw`update public.workflow set active_version_id = null where id = ${flow.id}`;
    await expect(workflows.setEnabled(owner(), { id: flow.id, enabled: true }))
      .rejects.toThrow(/no published version/);
  });

  it("does not fire for a night it spent switched off", async () => {
    /**
     * A schedule keeps its due time while the workflow is off, and would
     * fire the moment it came back on, for an occurrence possibly weeks in
     * the past. Switching off clears the clock so it is planned fresh.
     */
    const flow = await scheduled();
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await schedule.tick(db(), { now: new Date("2026-09-22T17:00:00Z") });

    await workflows.setEnabled(owner(), { id: flow.id, enabled: false });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });

    // Days later. A stale due time would fire here.
    const [result] = await schedule.tick(db(), { now: new Date("2026-09-26T17:00:00Z") });
    expect(result!.action).toBe("planned");
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(0);
  });

  it("switching off does not abandon a run already waiting", async () => {
    // Stopping halfway through leaves the customer with half a conversation.
    const flow = await workflows.create(owner(), {
      name: "Wait then chase", triggerKind: "schedule", schedule: "0 23 * * *",
      steps: [{ kind: "wait", config: { days: 1 } }, TASK_STEP],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await schedule.tick(db(), { now: new Date("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: new Date("2026-09-23T04:00:30Z") });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: false });

    await raw`update public.workflow_run set resume_at = now() - interval '1 minute'
              where organization_id = ${ORG}`;
    const [resumed] = await schedule.resumeDue(db());
    expect(resumed!.run.status).toBe("succeeded");
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(1);
  });
});

run("changing one", () => {
  it("publishes a new version rather than editing the old one", async () => {
    /**
     * A run records which version it executed, so "why did this customer get
     * that text in March" stays answerable after four edits. Editing in
     * place is what makes that question unanswerable, and it is the question
     * that gets asked.
     */
    const flow = await workflows.create(owner(), {
      name: "Chase", triggerKind: "event", triggerEvents: ["estimate.sent"], steps: [TASK_STEP],
    });
    await workflows.publish(owner(), {
      id: flow.id, name: "Chase, harder", triggerKind: "event",
      triggerEvents: ["estimate.sent"], steps: [TASK_STEP, { kind: "wait", config: { days: 1 } }],
    });

    const versions = await raw<{ version: number }[]>`
      select version from public.workflow_version where workflow_id = ${flow.id} order by version`;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    const detail = await workflows.detail(owner(), { id: flow.id });
    expect(detail.workflow.name).toBe("Chase, harder");
    expect(detail.version!.version).toBe(2);
  });

  it("applies the same permission rule to an edit", async () => {
    // Otherwise "create something harmless, then edit it into something
    // else" is the whole escalation with one extra step.
    const flow = await workflows.create(owner(), {
      name: "Chase", triggerKind: "event", triggerEvents: ["estimate.sent"], steps: [TASK_STEP],
    });
    await expect(workflows.publish(as(["dispatcher"]), {
      id: flow.id, name: "Chase", triggerKind: "event", triggerEvents: ["estimate.sent"],
      steps: [{ kind: "record_payment" }],
    })).rejects.toThrow();
  });

  it("refuses a schedule nobody can read on an edit too", async () => {
    // Same gate on the way in and the way through. Otherwise "save
    // something valid, then edit it into something broken" is a workflow
    // that silently never runs again.
    const flow = await workflows.create(owner(), {
      name: "Nightly", triggerKind: "schedule", schedule: "0 23 * * *", steps: [TASK_STEP],
    });
    await expect(workflows.publish(owner(), {
      id: flow.id, name: "Nightly", triggerKind: "schedule", schedule: "sometimes",
      steps: [TASK_STEP],
    })).rejects.toThrow(/five fields/);
  });

  it("keeps the runs when it is deleted", async () => {
    // "Why did this customer get that text in March" still has an answer
    // after somebody tidied up in April.
    const flow = await workflows.create(owner(), {
      name: "Nightly", triggerKind: "schedule", schedule: "0 23 * * *", steps: [TASK_STEP],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await schedule.tick(db(), { now: new Date("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: new Date("2026-09-23T04:00:30Z") });

    await workflows.remove(owner(), { id: flow.id });
    expect(await workflows.list(owner())).toHaveLength(0);
    expect(await raw`select id from public.workflow_run where workflow_id = ${flow.id}`)
      .toHaveLength(1);
  });
});

run("seeing what happened", () => {
  it("shows the schedule in words and when it next runs", async () => {
    const flow = await workflows.create(owner(), {
      name: "Nightly", triggerKind: "schedule", schedule: "0 23 * * *", steps: [TASK_STEP],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await schedule.tick(db(), { now: new Date("2026-09-22T17:00:00Z") });

    const [summary] = await workflows.list(owner());
    expect(summary!.scheduleText).toBe("Every day at 23:00");
    // Eleven at night in Chicago is four in the morning UTC.
    expect(summary!.nextRunAt!.toISOString()).toBe("2026-09-23T04:00:00.000Z");
  });

  it("surfaces a schedule the engine could not read", async () => {
    // Saved before this build could refuse it, or edited in the database.
    // Either way the screen says so rather than showing a workflow that
    // silently never runs.
    const flow = await workflows.create(owner(), {
      name: "Nightly", triggerKind: "schedule", schedule: "0 23 * * *", steps: [TASK_STEP],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await raw`update public.workflow set schedule = 'whenever' where id = ${flow.id}`;
    await schedule.tick(db(), { now: new Date("2026-09-22T17:00:00Z") });

    const [summary] = await workflows.list(owner());
    expect(summary!.scheduleError).toMatch(/five fields/);
  });

  it("shows each step of each run, which is the question people ask", async () => {
    const flow = await workflows.create(owner(), {
      name: "Nightly", triggerKind: "schedule", schedule: "0 23 * * *",
      steps: [{ kind: "wait", config: { days: 1 } }, TASK_STEP],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await schedule.tick(db(), { now: new Date("2026-09-22T17:00:00Z") });
    await schedule.tick(db(), { now: new Date("2026-09-23T04:00:30Z") });

    const detail = await workflows.detail(owner(), { id: flow.id });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]!.status).toBe("waiting");
    expect(detail.runs[0]!.resumeAt).toBeTruthy();
    expect(detail.runs[0]!.steps.map((s) => s.kind)).toEqual(["wait"]);
  });

  it("offers only the steps this build can actually perform", async () => {
    /**
     * `STEP_PERMISSIONS` lists more kinds than the runner implements,
     * deliberately: it is the set a definition may name. Offering those on
     * the screen would be offering a step that does nothing at run time.
     */
    const kinds = workflows.availableSteps(owner()).map((s) => s.kind);
    expect(kinds).toEqual(["send_message", "create_task", "wait"]);
    expect(kinds).not.toContain("record_payment");
  });

  it("marks the steps a reader cannot publish rather than hiding them", async () => {
    // A step missing from the list reads as a product that cannot do the
    // thing, rather than as an account that may not.
    const dispatcher = workflows.availableSteps(as(["dispatcher"]));
    const send = dispatcher.find((s) => s.kind === "send_message")!;
    const task = dispatcher.find((s) => s.kind === "create_task")!;
    expect(send.allowed).toBe(true);
    expect(task.allowed).toBe(false);
    expect(task.permissions).toEqual(["task:write"]);
  });

  it("offers events from a list rather than a text box", async () => {
    // An event name with a typo in it matches nothing and says nothing.
    const events = await workflows.triggerEvents(owner());
    expect(events).toContain("estimate.sent");
    expect(events).toContain("job.completed");
  });
});
