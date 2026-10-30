import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as talks from "../src/services/safety-talks";
import * as safety from "../src/services/safety";
import * as holidays from "../src/services/holidays";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * CHANGING A SCHEDULED TALK (M23)
 *
 * The topic, the audience, the time, the place, who leads it and whether it
 * skips holidays change from the next talk raised. A talk already raised keeps
 * its words, its sheet, its time and its place. The audit log holds the
 * schedule before and after.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("talk-edit:org");
const OWNER = fixtureId("talk-edit:owner");
const TECH_USER = fixtureId("talk-edit:tech-user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let north = "";
let south = "";
const tech: Record<string, string> = {};

async function member(name: string, branch: string): Promise<string> {
  const userId = crypto.randomUUID();
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${name.toLowerCase()}@talkedit.test`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, 'technician', ${branch}) returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${m!.id}, ${name}, true) returning id`;
  tech[name] = t!.id;
  return t!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@talkedit.test'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public."user" where email like '%@talkedit.test'`;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Talk Edit Co", slug: "talk-edit-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public.safety_talk_schedule where organization_id = ${ORG}`;
  const [n] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'North') returning id`;
  const [s] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'South') returning id`;
  north = n!.id;
  south = s!.id;
  await member("Ray", north);
  await member("Dana", south);
  await raw`delete from public."user" where id = ${TECH_USER}`;
  await raw`insert into public."user" (id, email, name) values (${TECH_USER}, 'sam@talkedit.test', 'Sam Tech')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${TECH_USER}, 'technician'::member_role)`;
});

const TUESDAY = new Date("2026-10-06T14:00:00Z");
const WEDNESDAY = new Date("2026-10-07T14:00:00Z");
const daily = { frequency: "daily" as const, startsOn: "2026-01-01" };

const topic = (title: string, body = "Water, rest, shade.") => talks.createTopic(owner(), { title, body });
const sheetOf = async (id: string) => (await safety.getMeeting(owner(), { id })).attendees.map((a) => a.name).sort();

run("a talk already raised keeps what it was given", () => {
  it("keeps its words, its sheet, its time and its place when the schedule changes, and the next one takes the new", async () => {
    const heat = await topic("Heat");
    const ladders = await topic("Ladders", "Three points of contact.");
    const schedule = await talks.createSchedule(owner(), {
      topicId: heat.id, branchId: north, ...daily, heldMinutes: 7 * 60, location: "The shop", ledBy: "Pat",
    });
    const [tuesdays] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    expect(await sheetOf(tuesdays!)).toEqual(["Ray"]);

    const changed = await talks.updateSchedule(owner(), {
      id: schedule.id, topicId: ladders.id, branchId: south, heldMinutes: 6 * 60 + 30, location: "The yard", ledBy: "Sam",
    });
    expect(changed).toMatchObject({
      topicTitle: "Ladders", audience: "branch", branchId: south, who: "Everybody in South", heldMinutes: 390, location: "The yard", ledBy: "Sam",
    });

    // Tuesday's talk is as it was raised.
    const held = await safety.getMeeting(owner(), { id: tuesdays! });
    expect(held).toMatchObject({ topic: "Heat", notes: "Water, rest, shade.", location: "The shop", ledBy: "Pat" });
    expect(await sheetOf(tuesdays!)).toEqual(["Ray"]);
    const [tuesdayRow] = await raw<{ held_at: Date }[]>`select held_at from public.safety_meeting where id = ${tuesdays!}`;
    expect(tuesdayRow!.held_at.toISOString()).toBe("2026-10-06T12:00:00.000Z");

    // Wednesday's takes the new settings.
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toEqual([]);
    const [wednesdays] = await talks.raiseTalksFor(db(), ORG, WEDNESDAY);
    expect(await safety.getMeeting(owner(), { id: wednesdays! })).toMatchObject({ topic: "Ladders", notes: "Three points of contact.", location: "The yard", ledBy: "Sam" });
    expect(await sheetOf(wednesdays!)).toEqual(["Dana"]);
    const [wednesdayRow] = await raw<{ held_at: Date }[]>`select held_at from public.safety_meeting where id = ${wednesdays!}`;
    expect(wednesdayRow!.held_at.toISOString()).toBe("2026-10-07T11:30:00.000Z");
  });

  it("applies to today's talk too when the worker has not raised it yet", async () => {
    const heat = await topic("Heat");
    const ladders = await topic("Ladders", "Three points of contact.");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, everybody: true, ...daily });
    await talks.updateSchedule(owner(), { id: schedule.id, topicId: ladders.id });
    const [made] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    expect((await safety.getMeeting(owner(), { id: made! })).topic).toBe("Ladders");
    expect(await sheetOf(made!)).toEqual(["Dana", "Ray"]);
  });
});

run("what a change is", () => {
  it("keeps what is left out, including the days it comes round on", async () => {
    const heat = await topic("Heat");
    const schedule = await talks.createSchedule(owner(), {
      topicId: heat.id, role: "technician", frequency: "weekly", weekday: 2, startsOn: "2026-01-01", location: "The shop", skipHolidays: true,
    });
    const changed = await talks.updateSchedule(owner(), { id: schedule.id, ledBy: "Sam" });
    expect(changed).toMatchObject({
      audience: "role", role: "technician", frequency: "weekly", weekday: 2, startsOn: "2026-01-01",
      location: "The shop", ledBy: "Sam", skipHolidays: true, heldMinutes: 420, topicTitle: "Heat",
    });
  });

  it("replaces the audience whole, and the table's own check holds for each kind", async () => {
    const heat = await topic("Heat");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, crewId: undefined, branchId: north, ...daily });
    const person = await talks.updateSchedule(owner(), { id: schedule.id, technicianId: tech["Ray"]! });
    expect(person).toMatchObject({ audience: "person", technicianId: tech["Ray"], branchId: null, who: "Ray" });
    const role = await talks.updateSchedule(owner(), { id: schedule.id, role: "dispatcher" });
    expect(role).toMatchObject({ audience: "role", role: "dispatcher", technicianId: null });
    const everybody = await talks.updateSchedule(owner(), { id: schedule.id, everybody: true });
    expect(everybody).toMatchObject({ audience: "company", role: null, who: "Everybody" });
    const [row] = await raw<{ audience: string; audience_role: string | null; technician_id: string | null }[]>`
      select audience, audience_role, technician_id from public.safety_talk_schedule where id = ${schedule.id}`;
    expect(row).toEqual({ audience: "company", audience_role: null, technician_id: null });
  });

  it("refuses two audiences, a retired topic, a closed branch, a time that is not a time, and a change that changes nothing", async () => {
    const heat = await topic("Heat");
    const old = await topic("Old");
    await talks.updateTopic(owner(), { id: old.id, retired: true });
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, everybody: true, ...daily });
    await expect(talks.updateSchedule(owner(), { id: schedule.id, branchId: north, everybody: true })).rejects.toThrow(/Choose only one/);
    await expect(talks.updateSchedule(owner(), { id: schedule.id, topicId: old.id })).rejects.toThrow(/retired/);
    await raw`update public.business_unit set active = false where id = ${south}`;
    await expect(talks.updateSchedule(owner(), { id: schedule.id, branchId: south })).rejects.toThrow(/has been closed/);
    await expect(talks.updateSchedule(owner(), { id: schedule.id, heldMinutes: 24 * 60 })).rejects.toThrow(/time of day/);
    await expect(talks.updateSchedule(owner(), { id: schedule.id })).rejects.toThrow(/Say what to change/);
    await expect(talks.updateSchedule(owner(), { id: schedule.id, topicId: crypto.randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
    await expect(talks.updateSchedule(owner(), { id: crypto.randomUUID(), ledBy: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(talks.updateSchedule(owner(), { id: schedule.id, branchId: crypto.randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
    // Nothing was changed by any of them.
    const [list] = await talks.listSchedules(owner());
    expect(list).toMatchObject({ topicTitle: "Heat", audience: "company", heldMinutes: 420 });
  });

  it("can be changed while paused, and stays paused", async () => {
    const heat = await topic("Heat");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, everybody: true, ...daily });
    await talks.setScheduleActive(owner(), { id: schedule.id, active: false });
    const changed = await talks.updateSchedule(owner(), { id: schedule.id, skipHolidays: true });
    expect(changed).toMatchObject({ active: false, skipHolidays: true, nextOn: null });
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toEqual([]);
  });

  it("can switch holidays on and off, and the next talk follows it", async () => {
    const heat = await topic("Heat");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, everybody: true, ...daily });
    await holidays.create(owner(), { name: "Founders day", date: "2026-10-06", closed: true });
    await holidays.create(owner(), { name: "Staff day", date: "2026-10-07", closed: true });
    // Raised on a closed day, as it always was before holidays were skipped.
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toHaveLength(1);
    const changed = await talks.updateSchedule(owner(), { id: schedule.id, skipHolidays: true });
    expect(changed.skipHolidays).toBe(true);
    expect(changed.schedule).toContain("not on a holiday");
    expect(await talks.raiseTalksFor(db(), ORG, WEDNESDAY)).toEqual([]);
    const back = await talks.updateSchedule(owner(), { id: schedule.id, skipHolidays: false });
    expect(back.schedule).not.toContain("not on a holiday");
    expect(await talks.raiseTalksFor(db(), ORG, new Date("2026-10-08T14:00:00Z"))).toHaveLength(1);
  });
});

run("who may change one, and what is kept", () => {
  it("is for somebody who writes safety records, and a retry gets the first answer", async () => {
    const heat = await topic("Heat");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, everybody: true, ...daily });
    await expect(talks.updateSchedule(as(TECH_USER, ["technician"]), { id: schedule.id, ledBy: "Me" })).rejects.toThrow(PermissionError);
    const keyed: ServiceContext = { ...owner(), idempotencyKey: "talk-edit-1" };
    const first = await talks.updateSchedule(keyed, { id: schedule.id, ledBy: "Sam" });
    const again = await talks.updateSchedule(keyed, { id: schedule.id, ledBy: "Sam" });
    expect(again).toEqual(first);
    const audits = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'safety.schedule_changed'`;
    expect(audits).toHaveLength(1);
  });

  it("writes the schedule before and after to the audit log", async () => {
    const heat = await topic("Heat");
    const ladders = await topic("Ladders");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, branchId: north, ...daily, ledBy: "Pat" });
    await talks.updateSchedule(owner(), { id: schedule.id, topicId: ladders.id, everybody: true, ledBy: null });
    const [row] = await raw<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select before, after from public.audit_log
       where organization_id = ${ORG} and action = 'safety.schedule_changed' and entity_id = ${schedule.id}`;
    expect(row!.before).toMatchObject({ topicId: heat.id, audience: "branch", audienceBusinessUnitId: north, ledBy: "Pat" });
    expect(row!.after).toMatchObject({ topicId: ladders.id, audience: "company", audienceBusinessUnitId: null, ledBy: null });
  });

  it("does not touch another company's schedule", async () => {
    const heat = await topic("Heat");
    const schedule = await talks.createSchedule(owner(), { topicId: heat.id, everybody: true, ...daily });
    const otherOrg = fixtureId("talk-edit:other-org");
    const otherOwner = fixtureId("talk-edit:other-owner");
    await seedOrg(raw, { organizationId: otherOrg, userId: otherOwner, name: "Talk Edit Two Co", slug: "talk-edit-two-co" });
    const stranger: ServiceContext = {
      actor: { userId: otherOwner, organizationId: otherOrg, roles: ["owner"] as Actor["roles"] }, db: db(),
    };
    await expect(talks.updateSchedule(stranger, { id: schedule.id, ledBy: "Eve" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await talks.listSchedules(owner()))[0]!.ledBy).toBeNull();
  });
});
