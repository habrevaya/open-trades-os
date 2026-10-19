import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as talks from "../src/services/safety-talks";
import * as safety from "../src/services/safety";
import * as holidays from "../src/services/holidays";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TOOLBOX TALKS FOR A ROLE, A BRANCH OR THE WHOLE COMPANY, AND NOT ON A HOLIDAY (M23)
 *
 * What is pinned is who ends up on the sheet and who does not: only people
 * who work in the field and are active on the day, a role the company defined
 * replacing the preset on whoever holds it, a branch meaning the people in it;
 * a schedule told to skip holidays raises nothing on a closed day and a
 * schedule that is not told still does; a talk with nobody to put on the sheet
 * is not raised; and a topic's words can be changed without touching a sheet
 * already raised.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("talk-audiences:org");
const OWNER = fixtureId("talk-audiences:owner");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let north = "";
let south = "";
let apprentice = "";
const tech: Record<string, string> = {};
const users: string[] = [];

async function member(name: string, role: string, opts: {
  branch?: string; roleId?: string; membershipActive?: boolean; technician?: boolean; profileActive?: boolean;
} = {}): Promise<string> {
  const userId = crypto.randomUUID();
  users.push(userId);
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${name.toLowerCase()}@audiences.test`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership
    (organization_id, user_id, role, role_id, business_unit_id, active)
    values (${ORG}, ${userId}, ${role}, ${opts.roleId ?? null}, ${opts.branch ?? null}, ${opts.membershipActive ?? true}) returning id`;
  if (opts.technician === false) return "";
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${m!.id}, ${name}, ${opts.profileActive ?? true}) returning id`;
  tech[name] = t!.id;
  return t!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@audiences.test'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public."user" where email like '%@audiences.test'`;
  users.length = 0;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Audience Co", slug: "talk-audiences" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [n] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'North') returning id`;
  const [s] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'South') returning id`;
  north = n!.id;
  south = s!.id;
  const [r] = await raw<{ id: string }[]>`insert into public.role (organization_id, name, permissions)
    values (${ORG}, 'Apprentice', '[]'::jsonb) returning id`;
  apprentice = r!.id;

  await member("Ray", "technician", { branch: north });
  await member("Dana", "technician", { branch: south });
  await member("Eli", "crew_lead", { branch: north });
  await member("Fay", "technician", { branch: north, roleId: apprentice });
  // Not on any sheet: left the company, has no technician profile, or the profile is switched off.
  await member("Gus", "technician", { branch: north, membershipActive: false });
  await member("Hal", "technician", { branch: north, profileActive: false });
  await member("Ivy", "dispatcher", { branch: north, technician: false });
});

/** A Tuesday, nine in the morning in Chicago, so a daily schedule is due. */
const TUESDAY = new Date("2026-10-06T14:00:00Z");
const WEDNESDAY = new Date("2026-10-07T14:00:00Z");

async function topic(title = "Heat") {
  return talks.createTopic(owner(), { title, body: "Water, rest, shade." });
}

async function sheetOf(meetingId: string): Promise<string[]> {
  return (await safety.getMeeting(owner(), { id: meetingId })).attendees.map((a) => a.name).sort();
}

const daily = { frequency: "daily" as const, startsOn: "2026-01-01" };

run("a talk for everybody in the field", () => {
  it("puts every active person with a technician profile on the sheet, and nobody else", async () => {
    const t = await topic();
    const schedule = await talks.createSchedule(owner(), { topicId: t.id, everybody: true, ...daily });
    expect(schedule).toMatchObject({ audience: "company", who: "Everybody", crewId: null, technicianId: null, role: null, roleId: null, branchId: null });
    const [made] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    expect(await sheetOf(made!)).toEqual(["Dana", "Eli", "Fay", "Ray"]);
  });
});

run("a talk for a role", () => {
  it("is everybody on a preset role, leaving out those whose own role replaced it", async () => {
    const t = await topic();
    const schedule = await talks.createSchedule(owner(), { topicId: t.id, role: "technician", ...daily });
    expect(schedule).toMatchObject({ audience: "role", role: "technician", roleId: null, who: "Everybody with the Technician role" });
    const [made] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    // Fay holds the company's own Apprentice role, which replaces the preset; Eli is a crew lead.
    expect(await sheetOf(made!)).toEqual(["Dana", "Ray"]);
  });

  it("is everybody who holds a role the company defined", async () => {
    const t = await topic();
    const schedule = await talks.createSchedule(owner(), { topicId: t.id, roleId: apprentice, ...daily });
    expect(schedule).toMatchObject({ audience: "role", roleId: apprentice, role: null, who: "Everybody with the Apprentice role" });
    const [made] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    expect(await sheetOf(made!)).toEqual(["Fay"]);
  });

  it("refuses a role that is not one, both kinds of role at once, and a role from another company", async () => {
    const t = await topic();
    await expect(talks.createSchedule(owner(), { topicId: t.id, role: "wizard" as never, ...daily })).rejects.toThrow("not a role");
    await expect(talks.createSchedule(owner(), { topicId: t.id, role: "technician", roleId: apprentice, ...daily })).rejects.toThrow(ConflictError);
    await expect(talks.createSchedule(owner(), { topicId: t.id, roleId: crypto.randomUUID(), ...daily })).rejects.toThrow(NotFoundError);
  });
});

run("a talk for a branch", () => {
  it("is the people in it who work in the field", async () => {
    const t = await topic();
    const schedule = await talks.createSchedule(owner(), { topicId: t.id, branchId: north, ...daily });
    expect(schedule).toMatchObject({ audience: "branch", branchId: north, who: "Everybody in North" });
    const [made] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    expect(await sheetOf(made!)).toEqual(["Eli", "Fay", "Ray"]);
  });

  it("is refused for a branch that has been closed or is not ours", async () => {
    const t = await topic();
    await raw`update public.business_unit set active = false where id = ${south}`;
    await expect(talks.createSchedule(owner(), { topicId: t.id, branchId: south, ...daily })).rejects.toThrow("has been closed");
    await expect(talks.createSchedule(owner(), { topicId: t.id, branchId: crypto.randomUUID(), ...daily })).rejects.toThrow(NotFoundError);
  });
});

run("choosing who it is for", () => {
  it("takes exactly one audience, in words", async () => {
    const t = await topic();
    await expect(talks.createSchedule(owner(), { topicId: t.id, ...daily })).rejects.toThrow("Choose who the talk is for");
    await expect(talks.createSchedule(owner(), { topicId: t.id, branchId: north, everybody: true, ...daily }))
      .rejects.toThrow("Choose only one of them");
    await expect(talks.createSchedule(owner(), { topicId: t.id, technicianId: tech["Ray"]!, crewId: crypto.randomUUID(), ...daily }))
      .rejects.toThrow(/one crew or one person/);
  });

  it("is for whoever may run safety, and offers roles and open branches by name", async () => {
    const t = await topic();
    await expect(talks.createSchedule(as(OWNER, ["technician"]), { topicId: t.id, everybody: true, ...daily })).rejects.toThrow(PermissionError);
    await raw`update public.business_unit set active = false where id = ${south}`;
    const choices = await talks.audienceChoices(owner());
    expect(choices.branches.map((b) => b.name)).toEqual(["North"]);
    expect(choices.roles).toContainEqual({ value: "preset:technician", label: "Technician", own: false });
    expect(choices.roles).toContainEqual({ value: `custom:${apprentice}`, label: "Apprentice", own: true });
    await expect(talks.audienceChoices(as(OWNER, ["technician"]))).rejects.toThrow(PermissionError);
  });

  it("still takes a crew or a person, as before", async () => {
    const t = await topic();
    const person = await talks.createSchedule(owner(), { topicId: t.id, technicianId: tech["Ray"]!, ...daily });
    expect(person).toMatchObject({ audience: "person", who: "Ray", skipHolidays: false, schedule: "Every day" });
    const [made] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    expect(await sheetOf(made!)).toEqual(["Ray"]);
  });
});

run("a talk with nobody to put on the sheet", () => {
  it("is not raised, is said in the audit log, and is not tried again the same day", async () => {
    const t = await topic();
    const empty = await talks.createSchedule(owner(), { topicId: t.id, branchId: south, ...daily });
    await raw`update public.technician set active = false where display_name = 'Dana'`;
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toEqual([]);
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toEqual([]);
    const [skipped] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'safety.talk_skipped_nobody' and entity_id = ${empty.id}`;
    expect(skipped!.n).toBe(1);

    // When somebody is there again the next day, the talk comes round as usual.
    await raw`update public.technician set active = true where display_name = 'Dana'`;
    const [made] = await talks.raiseTalksFor(db(), ORG, WEDNESDAY);
    expect(await sheetOf(made!)).toEqual(["Dana"]);
  });
});

run("a schedule that skips the company's holidays", () => {
  it("raises nothing on a closed day, says so, and raises the next day's as usual", async () => {
    const t = await topic();
    const schedule = await talks.createSchedule(owner(), { topicId: t.id, everybody: true, skipHolidays: true, ...daily });
    expect(schedule).toMatchObject({ skipHolidays: true, schedule: "Every day, not on a holiday" });
    await holidays.create(owner(), { name: "Founders day", date: "2026-10-06", closed: true });

    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toEqual([]);
    // Skipped, not moved: the same day looked at again is still skipped, and it is not raised the day after instead.
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toEqual([]);
    const entries = await raw<{ after: Record<string, string> | null }[]>`select after from public.audit_log
      where organization_id = ${ORG} and action = 'safety.talk_skipped_holiday'`;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.after).toMatchObject({ occurrenceOn: "2026-10-06", holiday: "Founders day" });

    const [made] = await talks.raiseTalksFor(db(), ORG, WEDNESDAY);
    expect(made).toBeTruthy();
    expect((await talks.listSchedules(owner()))[0]!.lastRaisedOn).toBe("2026-10-07");
  });

  it("raises on a holiday when it was not told to skip them, as every schedule did before", async () => {
    const t = await topic();
    await talks.createSchedule(owner(), { topicId: t.id, everybody: true, ...daily });
    await holidays.create(owner(), { name: "Founders day", date: "2026-10-06", closed: true });
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toHaveLength(1);
  });

  it("does not skip a short day, which is a working day", async () => {
    const t = await topic();
    await talks.createSchedule(owner(), { topicId: t.id, everybody: true, skipHolidays: true, ...daily });
    await holidays.create(owner(), { name: "Early close", date: "2026-10-06", closed: false, opensAt: "07:00", closesAt: "12:00" });
    expect(await talks.raiseTalksFor(db(), ORG, TUESDAY)).toHaveLength(1);
  });

  it("honours a branch's own day off for that branch's talk and no one else's", async () => {
    const t = await topic();
    await talks.createSchedule(owner(), { topicId: t.id, branchId: north, skipHolidays: true, ...daily });
    await talks.createSchedule(owner(), { topicId: t.id, everybody: true, skipHolidays: true, ...daily });
    await holidays.create(owner(), { name: "North shop day", date: "2026-10-06", closed: true, businessUnitId: north });
    const made = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    // The company-wide talk goes ahead; the North branch's own does not.
    expect(made).toHaveLength(1);
    expect(await sheetOf(made[0]!)).toEqual(["Dana", "Eli", "Fay", "Ray"]);
  });
});

run("changing a topic's words", () => {
  it("does not touch a sheet already raised, and the next one uses the new words", async () => {
    const t = await topic("Ladders");
    await talks.createSchedule(owner(), { topicId: t.id, everybody: true, ...daily });
    const [first] = await talks.raiseTalksFor(db(), ORG, TUESDAY);
    const edited = await talks.updateTopic(owner(), { id: t.id, title: "Ladder footing", body: "Foot it. Three points of contact." });
    expect(edited).toMatchObject({ title: "Ladder footing", body: "Foot it. Three points of contact." });
    expect(await safety.getMeeting(owner(), { id: first! })).toMatchObject({ topic: "Ladders", notes: "Water, rest, shade." });
    const [second] = await talks.raiseTalksFor(db(), ORG, WEDNESDAY);
    expect(await safety.getMeeting(owner(), { id: second! })).toMatchObject({ topic: "Ladder footing", notes: "Foot it. Three points of contact." });
    await expect(talks.updateTopic(owner(), { id: t.id, body: "  " })).rejects.toThrow(ConflictError);
  });
});
