import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { PermissionError, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import * as apps from "../src/services/apps";
import * as reminders from "../src/services/app-request-reminders";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A REQUEST NOBODY HAS ANSWERED IS CHASED ONCE (M26)
 *
 * Everybody who could approve an app is told when it asks, and that first notice
 * is the one that gets buried. After a number of days the company sets (three
 * until it says otherwise) they are told once more, by the same notice path, and
 * never again for the same request. Not once it is answered or has ended.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const ORG = fixtureId("app-reminder:org");
const OWNER = fixtureId("app-reminder:owner");
const ADMIN = fixtureId("app-reminder:admin");
const LOOKER = fixtureId("app-reminder:looker");
const SLUG = "app-reminder-co";
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

let seq = 0;
const ask = (name: string) => apps.requestInstall(db(), {
  company: SLUG, name, permissions: ["job:read"], scopes: { job: "all" },
  redirectUri: "https://partner.example.test/back",
}, { ip: `203.0.113.${(seq += 1) % 250}` });

/** A request that asked `days` company days ago, with seven days to live from then. */
async function askedDaysAgo(name: string, days: number): Promise<string> {
  const request = await ask(name);
  await raw`
    update public.connected_app
       set created_at = (${companyToday(-days)}::date + time '13:00') at time zone ${ZONE},
           request_expires_at = now() + interval '3 days'
     where id = ${request.id}`;
  return request.id;
}

const worker = (): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId: ORG, roles: [], grants: [], agentId: "app-request-reminders" }, db: db(),
});
const pass = (now = new Date()) => inTenant(worker(), (tx) => reminders.remindIn(tx, worker(), now));

const noticesFor = (userId: string) => raw<{ kind: string; title: string; body: string | null; source_key: string; href: string | null }[]>`
  select kind, title, body, source_key, href from public.staff_notice
   where organization_id = ${ORG} and user_id = ${userId} order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Reminder Co", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  for (const [id, email, role] of [
    [ADMIN, "admin@app-reminder.test", "admin"],
    [LOOKER, "looker@app-reminder.test", "office_manager"],
  ] as const) {
    await raw`delete from public."user" where id = ${id}`;
    await raw`insert into public."user" (id, email) values (${id}, ${email})`;
    await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role)`;
  }
  await raw`delete from public.public_rate_limit where key like 'app-%'`;
});

afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.audit_log where organization_id = ${ORG} and action like 'app.%'`;
  await raw`delete from public.connected_app where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'appRequests' where id = ${ORG}`;
  await raw`delete from public.public_rate_limit where key like 'app-%'`;
});

run("the setting", () => {
  it("is three days until the company says otherwise, and reads back what was set", async () => {
    expect(await reminders.reminderSetting(owner())).toEqual({ days: 3 });
    expect(await reminders.setReminder(owner(), { days: 5 })).toEqual({ days: 5 });
    expect(await reminders.reminderSetting(owner())).toEqual({ days: 5 });
    expect(await reminders.setReminder(owner(), { days: null })).toEqual({ days: null });
    expect(await reminders.reminderSetting(owner())).toEqual({ days: null });
    const audited = await raw<{ before: { days: number | null }; after: { days: number | null } }[]>`
      select before, after from public.audit_log
       where organization_id = ${ORG} and action = 'organization.app_request_reminder_set' order by created_at`;
    expect(audited.map((a) => [a.before.days, a.after.days])).toEqual([[3, 5], [5, null]]);
  });

  it("refuses a number a request would not live to see", async () => {
    for (const days of [0, 7, -1, 2.5]) {
      await expect(reminders.setReminder(owner(), { days })).rejects.toBeInstanceOf(ConflictError);
    }
    await expect(reminders.setReminder(owner(), { days: 7 })).rejects.toThrow(/whole number from 1 to 6/);
    expect(await reminders.reminderSetting(owner())).toEqual({ days: 3 });
  });

  it("is for whoever may connect integrations, and anybody who may read settings can see it", async () => {
    await expect(reminders.setReminder(as(LOOKER, ["office_manager"]), { days: 2 })).rejects.toThrow(PermissionError);
    expect(await reminders.reminderSetting(as(LOOKER, ["office_manager"]))).toEqual({ days: 3 });
  });
});

run("the reminder", () => {
  it("tells everybody who could approve it, once, after the default three days, and not before", async () => {
    const id = await askedDaysAgo("Crew Planner", 2);
    expect(await pass()).toEqual([]);
    expect(await noticesFor(OWNER)).toHaveLength(1);

    await raw`update public.connected_app set created_at = created_at - interval '1 day' where id = ${id}`;
    expect(await pass()).toEqual([id]);

    for (const person of [OWNER, ADMIN]) {
      const told = await noticesFor(person);
      expect(told.map((t) => t.title)).toEqual(["Crew Planner is asking to connect", "Crew Planner is still waiting for an answer"]);
      expect(told[1]).toMatchObject({ kind: "app_request", source_key: `app_request_reminder:${id}` });
      expect(told[1]!.body).toBe("It asked 3 days ago and nobody has answered. Nothing is given until somebody says yes.");
      expect(told[1]!.href).toMatch(/^\/settings\/apps\/requests\//);
    }
    // The office manager can only look, so was never told, first time or this.
    expect(await noticesFor(LOOKER)).toHaveLength(0);
    const [row] = await raw<{ reminded_at: Date | null }[]>`select reminded_at from public.connected_app where id = ${id}`;
    expect(row!.reminded_at).not.toBeNull();
    expect(await raw`select 1 from public.audit_log where entity_id = ${id} and action = 'app.request_reminded'`).toHaveLength(1);
  });

  it("never reminds twice for the same request, however many passes or workers come round", async () => {
    const id = await askedDaysAgo("Crew Planner", 4);
    const results = await Promise.all([pass(), pass(), pass()]);
    expect(results.flat()).toEqual([id]);
    await pass();
    await pass(new Date(Date.now() + 5 * 86_400_000));
    expect((await noticesFor(OWNER)).filter((n) => n.title.includes("still waiting"))).toHaveLength(1);
  });

  it("counts the number the company set, from the day the app asked in the company's calendar", async () => {
    await reminders.setReminder(owner(), { days: 1 });
    const id = await askedDaysAgo("Late Asker", 1);
    // Asked at 11:30 last night: a day ago by the calendar, though not by twenty four hours.
    await raw`update public.connected_app set created_at = ((${companyToday(-1)}::date + time '23:30') at time zone ${ZONE}) where id = ${id}`;
    expect(await pass()).toEqual([id]);
    const [reminded] = (await noticesFor(OWNER)).slice(-1);
    expect(reminded!.body).toContain("It asked 1 day ago");

    await reminders.setReminder(owner(), { days: 6 });
    const other = await askedDaysAgo("Slow Asker", 5);
    expect(await pass()).toEqual([]);
    await raw`update public.connected_app set created_at = created_at - interval '1 day' where id = ${other}`;
    expect(await pass()).toEqual([other]);
  });

  it("is switched off by an empty setting", async () => {
    await reminders.setReminder(owner(), { days: null });
    await askedDaysAgo("Quiet One", 6);
    expect(await pass()).toEqual([]);
    expect((await noticesFor(OWNER)).filter((n) => n.title.includes("still waiting"))).toHaveLength(0);
  });

  it("does not remind about a request somebody answered, or one that has ended", async () => {
    const approved = await askedDaysAgo("Approved One", 4);
    const refused = await askedDaysAgo("Refused One", 4);
    const ended = await askedDaysAgo("Ended One", 4);
    await apps.approve(owner(), { id: approved });
    await apps.refuse(owner(), { id: refused, reason: "No thanks" });
    await raw`update public.connected_app set request_expires_at = now() - interval '1 hour' where id = ${ended}`;
    expect(await pass()).toEqual([]);
    expect((await noticesFor(OWNER)).filter((n) => n.title.includes("still waiting"))).toHaveLength(0);
  });

  it("a request lowered to now is reminded on the next pass, once", async () => {
    const id = await askedDaysAgo("Waiting", 2);
    expect(await pass()).toEqual([]);
    await reminders.setReminder(owner(), { days: 2 });
    expect(await pass()).toEqual([id]);
    expect(await pass()).toEqual([]);
  });

  it("goes through the same notice path: the person's own choice of where a notice goes applies", async () => {
    // Switching the app request notice off in the app leaves a row for the record but nothing on the bell.
    await raw`insert into public.staff_notice_setting (organization_id, user_id, kind, in_app, push, text)
              values (${ORG}, ${ADMIN}, 'app_request', false, false, false)
              on conflict do nothing`;
    const id = await askedDaysAgo("Choosy", 4);
    await pass();
    const [row] = await raw<{ in_app: boolean }[]>`
      select in_app from public.staff_notice where organization_id = ${ORG} and user_id = ${ADMIN}
         and source_key = ${`app_request_reminder:${id}`}`;
    expect(row).toBeDefined();
    expect(row!.in_app).toBe(false);
    await raw`delete from public.staff_notice_setting where organization_id = ${ORG} and user_id = ${ADMIN}`;
  });

  it("is found by the worker's cross-company lookup only when a reminder could be due", async () => {
    const listed = () => raw<{ organization_id: string }[]>`select organization_id from app.app_request_reminder_organizations(500)`;
    const ids = async () => (await listed()).map((r) => r.organization_id);
    expect(await ids()).not.toContain(ORG);
    const id = await askedDaysAgo("Lookup", 3);
    expect(await ids()).toContain(ORG);
    await reminders.setReminder(owner(), { days: null });
    expect(await ids()).not.toContain(ORG);
    await reminders.setReminder(owner(), { days: 6 });
    expect(await ids()).not.toContain(ORG);
    await reminders.setReminder(owner(), { days: 3 });
    expect(await ids()).toContain(ORG);
    await raw`update public.connected_app set reminded_at = now() where id = ${id}`;
    expect(await ids()).not.toContain(ORG);
  });
});
