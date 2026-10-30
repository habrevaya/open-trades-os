import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as staffNotices from "../src/services/staff-notices";
import * as defaults from "../src/services/notice-defaults";
import * as upkeep from "../src/services/notice-upkeep";
import type { ServiceContext } from "../src/services/context";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * NOTICE SETUP: THE COMPANY'S DEFAULTS GIVEN TO EVERYBODY, AND A PERSON'S OWN DIGEST HOUR (M34)
 *
 * The company can give its defaults for notices to people already here, after
 * being asked, and a kind a person chose on their own page is never replaced:
 * only a kind the defaults copied onto them, or one they never had a row for.
 * And a person chooses the hour of their daily email, inside the company's
 * day and never in its quiet hours, and the worker sends it then.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("notice-setup:org");
const OWNER = fixtureId("notice-setup:owner");
const EARLY = fixtureId("notice-setup:early");
const COPIED = fixtureId("notice-setup:copied");
const CHOOSER = fixtureId("notice-setup:chooser");
const PEOPLE = [EARLY, COPIED, CHOOSER];
const ZONE = "America/Chicago";
const OWNER_MAIL = "olga@notice-setup.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

/** An instant on the company's day `offset` from today, at `hour` o'clock there. */
function at(hour: number, offset = 0): Date {
  const day = companyToday(offset, ZONE);
  for (const behind of [5, 6]) {
    const instant = new Date(`${day}T${String(hour + behind).padStart(2, "0")}:00:00Z`);
    const local = Number(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", hourCycle: "h23" }).format(instant));
    if (local === hour) return instant;
  }
  throw new Error("no such hour");
}

async function person(userId: string, role: string, name: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${name.toLowerCase()}@notice-setup.test`}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role})`;
}

const rowOf = async (userId: string, kind: string) => (await raw<{ in_app: boolean; push: boolean; text: boolean; chosen: boolean }[]>`
  select in_app, push, text, chosen from public.staff_notice_setting
   where organization_id = ${ORG} and user_id = ${userId} and kind = ${kind}`)[0] ?? null;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Notice Setup Co", slug: "notice-setup-co" });
  await raw`update public.organization set timezone = ${ZONE},
    settings = coalesce(settings, '{}'::jsonb) || '{"quietHours":{"startHour":21,"endHour":8}}'::jsonb where id = ${ORG}`;
  await raw`update public."user" set name = 'Olga Owner', email = ${OWNER_MAIL} where id = ${OWNER}`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in ${raw(PEOPLE)}`;
  await raw.end();
});

run("giving the company's defaults to everybody already here", () => {
  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.staff_notice_default where organization_id = ${ORG}`;
    await raw`delete from public.staff_notice_setting where organization_id = ${ORG}`;
    await raw`delete from public.membership where organization_id = ${ORG} and user_id in ${raw(PEOPLE)}`;
  });

  it("fills in a kind nobody chose, replaces one the defaults copied, and keeps one a person chose", async () => {
    /** Here before the company set anything: no rows of their own. */
    await person(EARLY, "office_manager", "Ella");
    /** Joined while the company started people with the deadline on the phone off. */
    await defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: true, push: false }] });
    await person(COPIED, "office_manager", "Cole");
    expect(await rowOf(COPIED, "task_deadline")).toMatchObject({ push: false, chosen: false });
    /** Chose on their own page to have the deadline off in the app. */
    await person(CHOOSER, "office_manager", "Chad");
    await staffNotices.setSwitches(as(CHOOSER, ["office_manager"]), {
      kinds: [{ kind: "task_deadline", inApp: false, push: false, text: false }],
    });
    expect(await rowOf(CHOOSER, "task_deadline")).toMatchObject({ chosen: true });

    /** The company now wants the deadline in the app and not on the phone, and an automatic payment nowhere but the app. */
    await defaults.setDefaults(owner(), {
      kinds: [{ kind: "task_deadline", inApp: true, push: false }, { kind: "autopay_failed", inApp: true, push: false }],
    });
    const preview = await defaults.applyPreview(owner());
    expect(preview).toMatchObject({ people: 4, keptOwn: 1 });

    const done = await defaults.applyToEverybody(owner(), { confirmed: true });
    expect(done).toEqual(preview);

    expect(await rowOf(EARLY, "task_deadline")).toMatchObject({ in_app: true, push: false, text: false, chosen: false });
    expect(await rowOf(EARLY, "autopay_failed")).toMatchObject({ in_app: true, push: false, chosen: false });
    expect(await rowOf(COPIED, "autopay_failed")).toMatchObject({ push: false });
    /** Their own choice is theirs. */
    expect(await rowOf(CHOOSER, "task_deadline")).toMatchObject({ in_app: false, push: false, chosen: true });
    /** A kind they never chose takes the company's. */
    expect(await rowOf(CHOOSER, "autopay_failed")).toMatchObject({ in_app: true, push: false, chosen: false });
    /** A kind the company never changed stays the product's own: no row written. */
    expect(await rowOf(EARLY, "po_approval")).toBeNull();

    /** Again changes nothing more. */
    expect(await defaults.applyToEverybody(owner(), { confirmed: true })).toMatchObject({ changed: 0, kinds: 0 });
    const lines = await raw<{ after: { changed: number } }[]>`select "after" from public.audit_log
      where organization_id = ${ORG} and action = 'staff_notice_defaults.applied' order by created_at`;
    expect(lines.map((l) => l.after.changed)).toEqual([done.changed, 0]);
  });

  it("marks only a kind a person changed as their own, though their page sends every kind", async () => {
    await defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: true, push: false }] });
    await person(COPIED, "office_manager", "Cole");
    const mine = await staffNotices.settings(as(COPIED, ["office_manager"]));
    await staffNotices.setSwitches(as(COPIED, ["office_manager"]), {
      kinds: mine.kinds.map((k) => (k.kind === "po_approval"
        ? { kind: k.kind, inApp: true, push: false, text: false }
        : { kind: k.kind, inApp: k.inApp, push: k.push, text: k.text, ...(k.email === null ? {} : { email: k.email }) })),
    });
    expect(await rowOf(COPIED, "task_deadline")).toMatchObject({ push: false, chosen: false });
    expect(await rowOf(COPIED, "po_approval")).toMatchObject({ push: false, chosen: true });
    expect(await rowOf(COPIED, "task_assigned")).toBeNull();
  });

  it("asks first, and is the company's: settings:read to look, settings:write to do", async () => {
    await person(EARLY, "office_manager", "Ella");
    await expect(defaults.applyToEverybody(owner(), { confirmed: false })).rejects.toThrow(/Say yes/);
    expect((await defaults.applyPreview(as(EARLY, ["office_manager"]))).people).toBe(2);
    await expect(defaults.applyToEverybody(as(EARLY, ["office_manager"]), { confirmed: true })).rejects.toThrow(PermissionError);
  });
});

run("a person's own hour for the daily email", () => {
  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.staff_notice where organization_id = ${ORG}`;
    await raw`delete from public.staff_notice_digest where organization_id = ${ORG}`;
    await raw`delete from public.task where organization_id = ${ORG}`;
    await raw`delete from public.message where organization_id = ${ORG}`;
    await raw`delete from public.integration_connection where organization_id = ${ORG} and capability = 'email'`;
  });

  it("is an hour of the company's day outside its quiet hours, back to the morning with null, and audited", async () => {
    const view = await staffNotices.setDigest(owner(), { on: true, hour: 14 });
    expect(view.digest).toMatchObject({ on: true, hour: 14 });
    expect(view.digestHour).toEqual({ own: 14, company: 8, choices: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] });

    await expect(staffNotices.setDigest(owner(), { on: true, hour: 22 })).rejects.toThrow(/from 8 to 20/);
    await expect(staffNotices.setDigest(owner(), { on: true, hour: 6 })).rejects.toThrow(/quiet hours/);

    /** Left out keeps it; turning it off keeps it too. */
    expect((await staffNotices.setDigest(owner(), { on: false })).digestHour.own).toBe(14);
    const back = await staffNotices.setDigest(owner(), { on: false, hour: null });
    expect(back.digest.hour).toBe(8);
    expect(back.digestHour.own).toBeNull();

    const lines = await raw<{ before: { hour: number | null }; after: { hour: number | null } }[]>`
      select "before", "after" from public.audit_log
       where organization_id = ${ORG} and action = 'staff_notice_digest.hour_changed' order by created_at`;
    expect(lines.map((l) => [l.before.hour, l.after.hour])).toEqual([[null, 14], [14, null]]);
  });

  it("is sent by the worker at the person's hour, not at the morning hour", async () => {
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
      values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@notice-setup.test","fromName":"Setup Co"}'::jsonb)`;
    const [task] = await raw<{ id: string }[]>`insert into public.task (organization_id, title) values (${ORG}, 'Ring the supplier') returning id`;
    await raw`insert into public.staff_notice (organization_id, user_id, kind, source_key, title, entity_type, entity_id, href)
      values (${ORG}, ${OWNER}, 'task_assigned', 'test:digest-hour', 'Ring the supplier', 'task', ${task!.id}, ${`/tasks/${task!.id}`})`;
    await staffNotices.setDigest(owner(), { on: true, hour: 14 });

    expect((await upkeep.upkeepFor(db(), ORG, at(9))).digested).toBe(0);
    expect((await upkeep.upkeepFor(db(), ORG, at(13))).digested).toBe(0);
    expect((await upkeep.upkeepFor(db(), ORG, at(14))).digested).toBe(1);
    expect((await upkeep.upkeepFor(db(), ORG, at(16))).digested).toBe(0);
    const mail = await raw`select id from public.message where organization_id = ${ORG} and channel = 'email' and to_address = ${OWNER_MAIL}`;
    expect(mail).toHaveLength(1);
  });

  it("goes at the morning hour when the company's quiet hours later cover the hour chosen", async () => {
    await staffNotices.setDigest(owner(), { on: true, hour: 20 });
    await raw`update public.organization set settings = settings || '{"quietHours":{"startHour":19,"endHour":8}}'::jsonb where id = ${ORG}`;
    try {
      const view = await staffNotices.settings(owner());
      expect(view.digest.hour).toBe(8);
      expect(view.digestHour.own).toBe(20);
    } finally {
      await raw`update public.organization set settings = settings || '{"quietHours":{"startHour":21,"endHour":8}}'::jsonb where id = ${ORG}`;
    }
  });
});
