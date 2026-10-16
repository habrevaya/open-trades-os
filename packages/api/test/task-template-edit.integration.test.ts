import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as rules from "../src/services/task-rules";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { createTaskTemplate, updateTaskTemplate } from "../src/contracts";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * CHANGING A RECURRING TASK, AS THE RECURRING SCREEN DOES
 *
 * The screen sends every box of its form to `PATCH /v1/task-templates/{id}`,
 * so a box emptied is a thing taken off. These say that whole payload is
 * stored, that it applies to the next occurrence and leaves the tasks already
 * raised alone, that it is refused in the same words as adding one, and that
 * somebody who may not change tasks may not change this.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tedit:org");
const OWNER = fixtureId("tedit:owner");
const TECH = fixtureId("tedit:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const tech = () => as(TECH, ["technician"]);
const at = (day: string) => rules.raiseRecurringFor(db(), ORG, new Date(`${day}T20:00:00Z`));

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Template Edit Co", slug: "template-edit-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`delete from public."user" where id = ${TECH}`;
  await raw`insert into public."user" (id, email, name) values (${TECH}, 'tech@template-edit-co.test', 'Sam Tech')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH}, 'technician'::member_role)`;
});

const taskOn = async (day: string) => {
  const [task] = await raw<{ id: string; title: string; body: string | null; assignee: string | null; due: Date }[]>`
    select id, title, body, assignee_user_id as assignee, due_at as due from public.task
    where organization_id = ${ORG} and occurrence_on = ${day}`;
  const items = task
    ? (await raw<{ label: string }[]>`select label from public.task_checklist_item where task_id = ${task.id} order by position`)
      .map((i) => i.label)
    : [];
  return task ? { ...task, items } : null;
};

run("changing a recurring task", () => {
  it("stores the whole form, from the next occurrence, and leaves tasks already raised alone", async () => {
    const made = await rules.createTemplate(owner(), createTaskTemplate.input.parse({
      title: "Check the vans", body: "Walk round each one", frequency: "weekly", weekday: 1, dueMinutes: 9 * 60,
      checklist: ["Tyres", "Oil"], assigneeUserId: TECH, startsOn: "2026-09-28",
    }));
    expect(await at("2026-10-05")).toHaveLength(1);

    // Exactly what the screen posts: every box, the emptied ones as empty.
    const changed = await rules.handlers.updateTaskTemplate(owner(), updateTaskTemplate.input.parse({
      id: made.id, title: "Check the vans and trailers", body: "", priority: "high",
      frequency: "every_n_weeks", weekday: 3, intervalWeeks: 2, dueMinutes: 8 * 60 + 30,
      startsOn: "2026-10-07", skipHolidays: false, assigneeUserId: null, checklist: ["Tyres", "Oil", "Lights"],
    }));
    expect(changed).toMatchObject({
      title: "Check the vans and trailers", body: null, priority: "high", assigneeUserId: null,
      schedule: "Every 2 weeks on Wednesday", dueMinutes: 510, checklist: ["Tyres", "Oil", "Lights"],
    });

    // The Monday task was already in the queue and is not rewritten.
    expect(await taskOn("2026-10-05")).toMatchObject({
      title: "Check the vans", body: "Walk round each one", assignee: TECH, items: ["Tyres", "Oil"],
    });
    // The next one is raised from the changed template.
    expect(await at("2026-10-07")).toHaveLength(1);
    const next = await taskOn("2026-10-07");
    expect(next).toMatchObject({ title: "Check the vans and trailers", assignee: null, items: ["Tyres", "Oil", "Lights"] });
    // Half past eight in Chicago in October is 13:30 UTC.
    expect(next!.due.toISOString()).toBe("2026-10-07T13:30:00.000Z");
    // The old Monday is not raised again, and a missed day is not made up.
    expect(await at("2026-10-12")).toEqual([]);
  });

  it("is refused in the words adding one is refused in", async () => {
    const made = await rules.createTemplate(owner(), { title: "Open up", frequency: "daily" });
    const refusal = async (promise: Promise<unknown>) => promise.then(() => null, (e: Error) => e.message);

    const adding = await refusal(rules.createTemplate(owner(), { title: "X", frequency: "weekly" }));
    const changing = await refusal(rules.updateTemplate(owner(), { id: made.id, frequency: "weekly" }));
    expect(adding).toBe("A weekly task needs the day of the week it comes round on.");
    expect(changing).toBe(adding);

    const noDays = await refusal(rules.updateTemplate(owner(), { id: made.id, frequency: "chosen_weekdays", daysOfWeek: [] }));
    expect(noDays).toBe("Tick at least one day of the week it comes round on.");
    await expect(rules.updateTemplate(owner(), { id: made.id, title: "   " })).rejects.toThrow(ConflictError);
    // Nothing was half saved by the refusals.
    expect((await rules.listTemplates(owner())).find((t) => t.id === made.id)).toMatchObject({ title: "Open up", frequency: "daily" });
  });

  it("is the office's to do: a technician may read recurring tasks and not change one", async () => {
    const made = await rules.createTemplate(owner(), { title: "Open up", frequency: "daily" });
    expect(await rules.listTemplates(tech())).toHaveLength(1);
    await expect(rules.updateTemplate(tech(), { id: made.id, title: "Mine now" })).rejects.toThrow(PermissionError);
  });

  it("keeps the audit trail of what a change replaced", async () => {
    const made = await rules.createTemplate(owner(), { title: "Open up", frequency: "daily" });
    await rules.updateTemplate(owner(), { id: made.id, title: "Open up the shop" });
    const [line] = await raw<{ before: { title: string }; after: { title: string } }[]>`
      select before, after from public.audit_log
      where organization_id = ${ORG} and action = 'task_template.updated' and entity_id = ${made.id}`;
    expect(line).toMatchObject({ before: { title: "Open up" }, after: { title: "Open up the shop" } });
  });
});
