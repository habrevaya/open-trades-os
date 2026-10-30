import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as notices from "../src/services/staff-notices";
import * as onCall from "../src/services/office-on-call";
import * as obligations from "../src/services/obligations";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * ON CALL FOR THE OFFICE'S NOTICES
 *
 * A deadline about to be missed, a customer asking to change a visit and a
 * failed automatic payment tell everybody who handles them. A company can
 * keep an office rota and send any of the three kinds to whoever is on call
 * that day instead. Off until it does. When nobody on call today can be told,
 * everybody who handles it is, so a gap in the rota never leaves it unheard.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("office-on-call:org");
const OWNER = fixtureId("office-on-call:owner");
const OFFICE = fixtureId("office-on-call:office");
const OFFICE_TWO = fixtureId("office-on-call:office-two");
const DISPATCH = fixtureId("office-on-call:dispatch");
const TECH = fixtureId("office-on-call:tech");
const PEOPLE = [OFFICE, OFFICE_TWO, DISPATCH, TECH];

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

async function person(userId: string, role: string, name: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${name.toLowerCase()}@office-on-call.test`}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role})`;
}

const toldAbout = (kind: string) => raw<{ user_id: string }[]>`
  select user_id from public.staff_notice where organization_id = ${ORG} and kind = ${kind} order by user_id`;

let jobId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Office On Call Co", slug: "office-on-call-co" });
  await person(OFFICE, "office_manager", "Olive");
  await person(OFFICE_TWO, "office_manager", "Otto");
  await person(DISPATCH, "dispatcher", "Dan");
  await person(TECH, "technician", "Tia");
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Rota Customer') returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Rota Rd', 'Austin', 'TX', '78701') returning id`;
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 9101, ${c!.id}, ${p!.id}, 'scheduled', 'Boiler check') returning id`;
  jobId = j!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in ${raw(PEOPLE)}`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.office_on_call where organization_id = ${ORG}`;
  await raw`update public.organization set settings = coalesce(settings, '{}'::jsonb) - 'officeOnCall' where id = ${ORG}`;
  await raw`delete from public.obligation where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
});

const aDeadline = () => raw`
  insert into public.obligation (organization_id, kind, entity_type, entity_id, due_at, consequence, escalate_at)
  values (${ORG}, 'test.deadline', 'job', ${jobId}, now() + interval '2 hours', 'The client refuses a late visit.', now() - interval '1 minute')`;

run("the office's on call rota", () => {
  it("changes nothing until the company sends a kind to it: everybody who handles a deadline is told", async () => {
    await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday(2) });
    const view = await onCall.view(owner());
    expect(view.kinds.every((k) => !k.on)).toBe(true);
    expect(view.onCallToday).toEqual(["Olive"]);

    await aDeadline();
    await obligations.sweep(owner());
    expect((await toldAbout("task_deadline")).map((r) => r.user_id).sort()).toEqual([OWNER, OFFICE, OFFICE_TWO].sort());
  });

  it("tells only whoever is on call today once the kind goes to the rota", async () => {
    await onCall.setKinds(owner(), { kinds: ["task_deadline"] });
    await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(-1), endsOn: companyToday() });
    await onCall.addTurn(owner(), { userId: OFFICE_TWO, startsOn: companyToday(1), endsOn: companyToday(3) });

    await aDeadline();
    await obligations.sweep(owner());
    expect((await toldAbout("task_deadline")).map((r) => r.user_id)).toEqual([OFFICE]);
  });

  it("tells two people on call on one day, both", async () => {
    await onCall.setKinds(owner(), { kinds: ["task_deadline"] });
    await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday() });
    await onCall.addTurn(owner(), { userId: OFFICE_TWO, startsOn: companyToday(), endsOn: companyToday(1) });
    await aDeadline();
    await obligations.sweep(owner());
    expect((await toldAbout("task_deadline")).map((r) => r.user_id).sort()).toEqual([OFFICE, OFFICE_TWO].sort());
  });

  it("falls back to everybody when nobody is on call today", async () => {
    await onCall.setKinds(owner(), { kinds: ["task_deadline"] });
    await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(1), endsOn: companyToday(2) });
    await aDeadline();
    await obligations.sweep(owner());
    expect((await toldAbout("task_deadline")).map((r) => r.user_id).sort()).toEqual([OWNER, OFFICE, OFFICE_TWO].sort());
  });

  it("falls back to everybody when the person on call cannot answer this kind", async () => {
    await onCall.setKinds(owner(), { kinds: ["task_deadline"] });
    /** A dispatcher answers visit changes, so may be on the rota, but holds no task permission. */
    await onCall.addTurn(owner(), { userId: DISPATCH, startsOn: companyToday(), endsOn: companyToday() });
    await aDeadline();
    await obligations.sweep(owner());
    expect((await toldAbout("task_deadline")).map((r) => r.user_id).sort()).toEqual([OWNER, OFFICE, OFFICE_TWO].sort());
  });

  it("does not spill over to everybody when the person on call was told already", async () => {
    await onCall.setKinds(owner(), { kinds: ["task_deadline"] });
    await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday() });
    const [task] = await raw<{ id: string }[]>`insert into public.task (organization_id, title, queue)
      values (${ORG}, 'A clock', 'office') returning id`;
    const raise = () => inTenant(owner(), (tx) => notices.raiseToHolders(tx, {
      organizationId: ORG, kind: "task_deadline", key: `task_deadline:test:${task!.id}`,
      title: "Deadline close: A clock", about: { type: "task", id: task!.id },
    }));
    expect(await raise()).toBe(1);
    expect(await raise()).toBe(0);
    expect((await toldAbout("task_deadline")).map((r) => r.user_id)).toEqual([OFFICE]);
  });

  it("leaves the other kinds to everybody, and a person sees their own turns on their page", async () => {
    await onCall.setKinds(owner(), { kinds: ["autopay_failed"] });
    await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday(1) });
    await aDeadline();
    await obligations.sweep(owner());
    expect((await toldAbout("task_deadline")).map((r) => r.user_id).sort()).toEqual([OWNER, OFFICE, OFFICE_TWO].sort());

    const mine = await notices.settings(as(OFFICE, ["office_manager"]));
    expect(mine.onCall).toEqual([{ startsOn: companyToday(), endsOn: companyToday(1), today: true }]);
    expect((await notices.settings(as(OFFICE_TWO, ["office_manager"]))).onCall).toEqual([]);
  });

  it("refuses a turn that is over, back to front, too long, or for somebody who could never be told", async () => {
    await expect(onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(-3), endsOn: companyToday(-1) }))
      .rejects.toThrow(/over already/);
    await expect(onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(2), endsOn: companyToday(1) }))
      .rejects.toThrow(/before the first day/);
    await expect(onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday(400) }))
      .rejects.toThrow(/at most 366 days/);
    await expect(onCall.addTurn(owner(), { userId: TECH, startsOn: companyToday(), endsOn: companyToday() }))
      .rejects.toThrow(ConflictError);
    await expect(onCall.setKinds(owner(), { kinds: ["task_assigned"] })).rejects.toThrow(/Only a deadline/);
    expect((await onCall.view(owner())).people.map((p) => p.name)).not.toContain("Tia");
  });

  it("adds the same turn once, removes it once, and audits each change", async () => {
    const first = await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday(1), note: "Weekend" });
    const again = await onCall.addTurn(owner(), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday(1) });
    expect(again.id).toBe(first.id);
    expect((await onCall.view(owner())).turns).toHaveLength(1);

    expect(await onCall.removeTurn(owner(), { id: first.id })).toEqual({ id: first.id, removed: true });
    expect(await onCall.removeTurn(owner(), { id: first.id })).toEqual({ id: first.id, removed: false });

    await onCall.setKinds(owner(), { kinds: ["visit_change_requested"] });
    const lines = await raw<{ action: string }[]>`select action from public.audit_log
      where organization_id = ${ORG} and action like 'office_on_call.%' order by created_at`;
    expect(lines.map((l) => l.action)).toEqual(expect.arrayContaining([
      "office_on_call.turn_added", "office_on_call.turn_removed", "office_on_call.kinds_changed",
    ]));
    const added = await raw<{ id: string }[]>`select id from public.audit_log
      where organization_id = ${ORG} and action = 'office_on_call.turn_added' and entity_id = ${first.id}`;
    expect(added).toHaveLength(1);
  });

  it("is the company's: settings:read to look and settings:write to change", async () => {
    await expect(onCall.view(as(TECH, ["technician"]))).rejects.toThrow(PermissionError);
    expect((await onCall.view(as(OFFICE, ["office_manager"]))).kinds).toHaveLength(3);
    await expect(onCall.addTurn(as(OFFICE, ["office_manager"]), { userId: OFFICE, startsOn: companyToday(), endsOn: companyToday() }))
      .rejects.toThrow(PermissionError);
    await expect(onCall.setKinds(as(OFFICE, ["office_manager"]), { kinds: ["task_deadline"] })).rejects.toThrow(PermissionError);
  });
});
