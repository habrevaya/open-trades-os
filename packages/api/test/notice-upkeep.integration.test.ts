import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { notices as rules, type Actor } from "@opentradesos/core";
import * as staffNotices from "../src/services/staff-notices";
import * as upkeep from "../src/services/notice-upkeep";
import { routes } from "../src/contracts";
import { dispatch } from "../src/http/dispatch";
import type { ServiceContext } from "../src/services/context";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * THE DAILY DIGEST, AND READ NOTICES TIDIED AWAY (M34)
 *
 * Against a real database, through the services, the routes and the
 * worker's own pass. What is pinned is what a person would notice: nobody
 * gets a digest they did not ask for; one who asked gets one email a
 * morning, never in the night, listing only what is unread on their bell
 * and they can still open; nothing on a day nothing is unread; a reason in
 * words when it cannot go. And a company that keeps read notices so many
 * days loses exactly those, never an unread one and never a licence or talk
 * notice the worker would raise again.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("notice-upkeep:org");
const OWNER = fixtureId("notice-upkeep:owner");
const OTHER = fixtureId("notice-upkeep:other");
const TECH = fixtureId("notice-upkeep:tech");
const ZONE = "America/Chicago";
const OWNER_MAIL = "olive@upkeep.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

/** An instant on the company's day `offset` from today, at `hour` o'clock there. */
function at(hour: number, offset = 0): Date {
  const day = companyToday(offset, ZONE);
  // Chicago is five or six hours behind UTC; find the one that lands on the hour asked.
  for (const behind of [5, 6]) {
    const instant = new Date(`${day}T${String(hour + behind).padStart(2, "0")}:00:00Z`);
    const local = Number(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", hourCycle: "h23" }).format(instant));
    if (local === hour) return instant;
  }
  throw new Error("no such hour");
}

async function aTask(title: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`insert into public.task (organization_id, title) values (${ORG}, ${title}) returning id`;
  return row!.id;
}

async function notice(userId: string, input: {
  title: string; entityId?: string; kind?: string; inApp?: boolean; readAt?: Date | null; createdAt?: Date;
}): Promise<string> {
  const entityId = input.entityId ?? await aTask(input.title);
  const [row] = await raw<{ id: string }[]>`
    insert into public.staff_notice (organization_id, user_id, kind, source_key, title, entity_type, entity_id, href, in_app, read_at, created_at)
    values (${ORG}, ${userId}, ${input.kind ?? "task_assigned"}, ${`test:${crypto.randomUUID()}`}, ${input.title}, 'task',
            ${entityId}, ${`/tasks/${entityId}`}, ${input.inApp ?? true}, ${input.readAt ?? null}, ${input.createdAt ?? new Date()})
    returning id`;
  return row!.id;
}

const mailTo = (address: string) => raw<{ subject: string; body: string | null }[]>`
  select subject, body from public.message
   where organization_id = ${ORG} and channel = 'email' and to_address = ${address} order by created_at`;

const digestRow = (userId: string) => raw<{ enabled: boolean; last_on: string | null; last_outcome: string | null }[]>`
  select enabled, last_on::text, last_outcome from public.staff_notice_digest where organization_id = ${ORG} and user_id = ${userId}`;

const connectEmail = () => raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
  values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@upkeep.test","fromName":"Upkeep Co"}'::jsonb)`;

async function person(userId: string, role: string, mail: string, name: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${mail}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${mail}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role})`;
}

async function call(name: keyof typeof routes, path: string, init: { method: string; body?: unknown }, ctx: ServiceContext) {
  const response = await dispatch(new Request(`http://localhost/api${path}`, {
    method: init.method,
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }), { db: db(), basePath: "/api", resolveSession: async () => ctx });
  return { status: response.status, body: await response.json() as Record<string, unknown>, route: routes[name] };
}

const WAS_URL = process.env["PUBLIC_URL"];

beforeAll(async () => {
  if (!url) return;
  process.env["PUBLIC_URL"] = "https://ops.upkeep.test";
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Upkeep Co", slug: "notice-upkeep-co" });
  await raw`update public.organization set timezone = ${ZONE},
    settings = coalesce(settings, '{}'::jsonb) || '{"quietHours":{"startHour":21,"endHour":8}}'::jsonb where id = ${ORG}`;
  await raw`update public."user" set name = 'Olive Owner', email = ${OWNER_MAIL} where id = ${OWNER}`;
  await person(OTHER, "office_manager", "oscar@upkeep.test", "Oscar Office");
  await person(TECH, "technician", "tess@upkeep.test", "Tess Tech");
});

afterAll(async () => {
  if (WAS_URL === undefined) delete process.env["PUBLIC_URL"]; else process.env["PUBLIC_URL"] = WAS_URL;
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${OTHER}, ${TECH})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice_digest where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.integration_connection where organization_id = ${ORG} and capability = 'email'`;
  await raw`update public.organization set settings = settings - 'readNotices' where id = ${ORG}`;
});

run("the daily digest", () => {
  it("is off until the person turns it on, and goes to nobody who did not", async () => {
    await connectEmail();
    await notice(OWNER, { title: "Call back Mrs Ortiz" });
    expect((await staffNotices.settings(owner())).digest).toEqual({ on: false, hour: 8, lastOn: null, lastOutcome: null });
    expect(await upkeep.upkeepFor(db(), ORG, at(10))).toMatchObject({ digested: 0, notSent: 0 });
    expect(await mailTo(OWNER_MAIL)).toHaveLength(0);
  });

  it("sends one email at the morning hour listing what is unread and can still be opened, and only one that day", async () => {
    await connectEmail();
    const on = await staffNotices.setDigest(owner(), { on: true });
    expect(on.digest.on).toBe(true);
    const [audited] = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'staff_notice_digest.on'`;
    expect(audited).toBeTruthy();

    const first = await notice(OWNER, { title: "Call back Mrs Ortiz" });
    await notice(OWNER, { title: "Order the condenser fan" });
    await notice(OWNER, { title: "Already read", readAt: new Date() });
    await notice(OWNER, { title: "Kept off the bell", inApp: false });
    const gone = await aTask("Removed since");
    await notice(OWNER, { title: "About a removed task", entityId: gone });
    await raw`delete from public.task where id = ${gone}`;
    // Somebody else's unread notice is theirs.
    await notice(OTHER, { title: "Oscar's own" });

    // Before the morning hour and in the night: nothing.
    expect((await upkeep.upkeepFor(db(), ORG, at(6))).digested).toBe(0);
    expect(await mailTo(OWNER_MAIL)).toHaveLength(0);

    expect((await upkeep.upkeepFor(db(), ORG, at(9))).digested).toBe(1);
    const mail = await mailTo(OWNER_MAIL);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe("2 unread notices at Upkeep Co");
    expect(mail[0]!.body).toContain("Call back Mrs Ortiz");
    expect(mail[0]!.body).toContain("Order the condenser fan");
    expect(mail[0]!.body).toContain(`Open it: https://ops.upkeep.test/notices/${first}`);
    expect(mail[0]!.body).toContain("https://ops.upkeep.test/me#notices");
    for (const left of ["Already read", "Kept off the bell", "About a removed task", "Oscar's own"]) {
      expect(mail[0]!.body).not.toContain(left);
    }
    expect(await digestRow(OWNER)).toEqual([{ enabled: true, last_on: companyToday(0, ZONE), last_outcome: "Sent, listing 2 unread." }]);
    expect(await mailTo("oscar@upkeep.test")).toHaveLength(0);

    // Later the same day, and two workers at once the next morning: one email a day.
    expect((await upkeep.upkeepFor(db(), ORG, at(15))).digested).toBe(0);
    const both = await Promise.all([upkeep.upkeepFor(db(), ORG, at(9, 1)), upkeep.upkeepFor(db(), ORG, at(9, 1))]);
    expect(both[0].digested + both[1].digested).toBe(1);
    expect(await mailTo(OWNER_MAIL)).toHaveLength(2);
  });

  it("sends nothing on a day nothing is unread, and says so", async () => {
    await connectEmail();
    await staffNotices.setDigest(owner(), { on: true });
    await notice(OWNER, { title: "Read already", readAt: new Date() });
    expect(await upkeep.upkeepFor(db(), ORG, at(9))).toMatchObject({ digested: 0, notSent: 1 });
    expect(await mailTo(OWNER_MAIL)).toHaveLength(0);
    expect((await staffNotices.settings(owner())).digest.lastOutcome).toBe("Nothing was unread, so nothing was sent.");
  });

  it("says in words why it could not go when the company has no email", async () => {
    await staffNotices.setDigest(owner(), { on: true });
    await notice(OWNER, { title: "Call back Mrs Ortiz" });
    expect(await upkeep.upkeepFor(db(), ORG, at(9))).toMatchObject({ digested: 0, notSent: 1 });
    const [row] = await digestRow(OWNER);
    expect(row!.last_outcome).toMatch(/^Not sent: /);
    expect(row!.last_outcome).toMatch(/email/i);
  });

  it("is turned on and off by the person on the API, and the worker's pass finds the company", async () => {
    await connectEmail();
    const turned = await call("setMyNoticeDigest", "/v1/me/notice-digest", { method: "POST", body: { on: true } }, owner());
    expect(turned.status).toBe(201);
    expect(turned.body["digest"]).toMatchObject({ on: true, hour: 8 });
    await notice(OWNER, { title: "Call back Mrs Ortiz" });
    const results = await upkeep.upkeepPass(db(), { only: [ORG], now: () => at(9) });
    expect(results.find((r) => r.organizationId === ORG)).toMatchObject({ digested: 1 });

    const off = await call("setMyNoticeDigest", "/v1/me/notice-digest", { method: "POST", body: { on: false } }, owner());
    expect(off.body["digest"]).toMatchObject({ on: false });
    expect(await digestRow(OWNER)).toMatchObject([{ enabled: false }]);
  });
});

run("how long read notices are kept", () => {
  it("keeps them for good until the company chooses, which needs settings:write and is audited", async () => {
    expect(await upkeep.keeping(owner())).toEqual({ keepDays: null });
    await expect(upkeep.setKeeping(as(TECH, ["technician"]), { keepDays: 30 })).rejects.toThrow();
    await expect(upkeep.setKeeping(owner(), { keepDays: 3 })).rejects.toThrow(/from 7 to 3650 days/);

    const set = await call("setReadNoticeKeeping", "/v1/notice-keeping", { method: "PATCH", body: { keepDays: 30 } }, owner());
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ keepDays: 30 });
    const got = await call("getReadNoticeKeeping", "/v1/notice-keeping", { method: "GET" }, owner());
    expect(got.body).toEqual({ keepDays: 30 });
    const [line] = await raw<{ before: unknown; after: unknown }[]>`
      select before, after from public.audit_log where organization_id = ${ORG} and action = 'organization.read_notices_kept'
       order by created_at desc limit 1`;
    expect(line).toMatchObject({ before: { keepDays: null }, after: { keepDays: 30 } });
  });

  it("removes exactly what core's rule allows, with their sends, and never an unread one", async () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const cases = [
      { title: "read long ago", readAt: ago(31), createdAt: ago(40) },
      { title: "read lately", readAt: ago(10), createdAt: ago(40) },
      { title: "never read", readAt: null, createdAt: ago(400) },
      { title: "off the bell, old", readAt: null, createdAt: ago(31), inApp: false },
      { title: "off the bell, new", readAt: null, createdAt: ago(5), inApp: false },
      { title: "licence, could come again", kind: "qualification_expiry", readAt: ago(60), createdAt: ago(61) },
      { title: "licence, long past", kind: "qualification_expiry", readAt: ago(370), createdAt: ago(380) },
      { title: "talk, a week", kind: "talk_unsigned", readAt: ago(31), createdAt: ago(8) },
      { title: "talk, done", kind: "talk_unsigned", readAt: ago(31), createdAt: ago(32) },
    ];
    const ids = new Map<string, string>();
    for (const c of cases) ids.set(c.title, await notice(OWNER, c));
    await raw`insert into public.staff_notice_delivery (organization_id, notice_id, channel, target, status)
      values (${ORG}, ${ids.get("read long ago")!}, 'email', ${OWNER_MAIL}, 'sent')`;

    // Kept for good: nothing goes.
    expect((await upkeep.upkeepFor(db(), ORG, now)).removed).toBe(0);

    await upkeep.setKeeping(owner(), { keepDays: 30 });
    const removed = (await upkeep.upkeepFor(db(), ORG, now)).removed;
    const left = new Set((await raw<{ title: string }[]>`
      select title from public.staff_notice where organization_id = ${ORG}`).map((r) => r.title));
    const expected = cases.filter((c) => rules.sweepable(
      { kind: c.kind ?? "task_assigned", createdAt: c.createdAt, readAt: c.readAt, inApp: c.inApp ?? true }, 30, now,
    )).map((c) => c.title);
    expect(expected.sort()).toEqual(["licence, long past", "off the bell, old", "read long ago", "talk, done"]);
    expect(removed).toBe(expected.length);
    for (const c of cases) expect(left.has(c.title)).toBe(!expected.includes(c.title));
    expect(await raw`select 1 from public.staff_notice_delivery where notice_id = ${ids.get("read long ago")!}`).toHaveLength(0);
    const [line] = await raw<{ after: { removed: number; keepDays: number } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'staff_notice.swept' order by created_at desc limit 1`;
    expect(line!.after).toEqual({ removed: expected.length, keepDays: 30 });
  });
});
