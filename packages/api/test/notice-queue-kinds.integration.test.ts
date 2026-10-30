import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as notices from "../src/services/staff-notices";
import * as defaults from "../src/services/notice-defaults";
import * as obligations from "../src/services/obligations";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * THE COMPANY'S DEFAULTS FOR NEW PEOPLE, AND A DEADLINE ABOUT TO BE MISSED
 *
 * The company sets what a person added from now on starts with, per kind of
 * notice. It seeds and never overrules: people already here are not changed,
 * a person's own choice is never replaced, and nobody is started on texts.
 * And a deadline escalated into the office queue tells the people who can
 * deal with it, only those who may open it, once.
 *
 * A customer's visit change request and a failed automatic payment raise the
 * same way; their tests sit beside the code they drive, in
 * visit-changes.integration.test.ts and card-on-file.integration.test.ts.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("notice-queue:org");
const OWNER = fixtureId("notice-queue:owner");
const OFFICE = fixtureId("notice-queue:office");
const DISPATCH = fixtureId("notice-queue:dispatch");
const TECH = fixtureId("notice-queue:tech");
const NEWBIE = fixtureId("notice-queue:newbie");
const NEWBIE_TWO = fixtureId("notice-queue:newbie-two");
const PEOPLE = [OFFICE, DISPATCH, TECH, NEWBIE, NEWBIE_TWO];

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

async function person(userId: string, role: string, name: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${name.toLowerCase()}@notice-queue.test`}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role})`;
}

const noticesFor = (userId: string, kind: string) => raw<{
  id: string; title: string; body: string | null; href: string; in_app: boolean; entity_type: string;
}[]>`select id, title, body, href, in_app, entity_type from public.staff_notice
     where organization_id = ${ORG} and user_id = ${userId} and kind = ${kind} order by created_at`;

const settingsRows = (userId: string) => raw<{ kind: string; in_app: boolean; push: boolean; text: boolean; email: boolean | null }[]>`
  select kind, in_app, push, text, email from public.staff_notice_setting
   where organization_id = ${ORG} and user_id = ${userId} order by kind`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Queue Notice Co", slug: "queue-notice-co" });
  await person(OFFICE, "office_manager", "Oscar");
  await person(DISPATCH, "dispatcher", "Dina");
  await person(TECH, "technician", "Tess");
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in ${raw(PEOPLE)}`;
  await raw.end();
});

run("what the company starts a new person's notices as", () => {
  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.staff_notice_default where organization_id = ${ORG}`;
    await raw`delete from public.staff_notice_setting where organization_id = ${ORG} and user_id in ${raw([NEWBIE, NEWBIE_TWO])}`;
    await raw`delete from public.membership where organization_id = ${ORG} and user_id in ${raw([NEWBIE, NEWBIE_TWO])}`;
  });

  it("is the product's own until the company changes something, and a new person gets no rows of their own", async () => {
    const view = await defaults.defaults(owner());
    expect(view.kinds.length).toBeGreaterThan(7);
    for (const k of view.kinds) expect(k).toMatchObject({ inApp: true, push: true });
    expect(view.kinds.find((k) => k.kind === "qualification_expiry")!.email).toBe(true);
    expect(view.kinds.find((k) => k.kind === "task_assigned")!.email).toBeNull();

    await person(NEWBIE, "office_manager", "Nell");
    expect(await settingsRows(NEWBIE)).toEqual([]);
  });

  it("is copied onto each person added afterwards, and onto nobody already here", async () => {
    const before = await settingsRows(OFFICE);
    await defaults.setDefaults(owner(), {
      kinds: [
        { kind: "task_deadline", inApp: true, push: false },
        { kind: "autopay_failed", inApp: false, push: true },
        { kind: "qualification_expiry", inApp: true, push: true, email: false },
      ],
    });
    expect(await settingsRows(OFFICE)).toEqual(before);

    await person(NEWBIE, "office_manager", "Nell");
    expect(await settingsRows(NEWBIE)).toEqual([
      { kind: "autopay_failed", in_app: false, push: true, text: false, email: null },
      { kind: "qualification_expiry", in_app: true, push: true, text: false, email: false },
      { kind: "task_deadline", in_app: true, push: false, text: false, email: null },
    ]);

    /** What the person sees on their own page is the same thing, and texts are off. */
    const mine = await notices.settings(as(NEWBIE, ["office_manager"]));
    const deadline = mine.kinds.find((k) => k.kind === "task_deadline")!;
    expect(deadline).toMatchObject({ inApp: true, push: false, text: false });
    expect(mine.kinds.find((k) => k.kind === "autopay_failed")).toMatchObject({ inApp: false, push: true, text: false });
    expect(mine.kinds.find((k) => k.kind === "qualification_expiry")!.email).toBe(false);
    expect(mine.kinds.find((k) => k.kind === "po_approval")).toMatchObject({ inApp: true, push: true, text: false });
  });

  it("never changes a person who is here when the company changes its mind again, nor replaces their own choice", async () => {
    await defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: true, push: false }] });
    await person(NEWBIE, "office_manager", "Nell");
    await notices.setSwitches(as(NEWBIE, ["office_manager"]), {
      kinds: [{ kind: "task_deadline", inApp: false, push: true, text: false }],
    });

    await defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: true, push: true }] });
    expect((await settingsRows(NEWBIE)).find((r) => r.kind === "task_deadline")).toMatchObject({ in_app: false, push: true });

    /** A person added after the second change starts on the second. */
    await person(NEWBIE_TWO, "csr", "Nia");
    expect((await settingsRows(NEWBIE_TWO)).find((r) => r.kind === "task_deadline")).toMatchObject({ in_app: true, push: true });
  });

  it("refuses an email box on a kind nothing emails, a kind that does not exist and a kind listed twice", async () => {
    await expect(defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: true, push: true, email: true }] }))
      .rejects.toThrow(/does not come by email/);
    await expect(defaults.setDefaults(owner(), { kinds: [{ kind: "task_asigned", inApp: true, push: true }] }))
      .rejects.toThrow(ConflictError);
    await expect(defaults.setDefaults(owner(), {
      kinds: [{ kind: "task_deadline", inApp: true, push: true }, { kind: "task_deadline", inApp: false, push: false }],
    })).rejects.toThrow(/twice/);
  });

  it("is the company's to read and to set: settings:read and settings:write, and audited", async () => {
    await expect(defaults.defaults(as(TECH, ["technician"]))).rejects.toThrow(PermissionError);
    await expect(defaults.setDefaults(as(DISPATCH, ["dispatcher"]), { kinds: [{ kind: "task_deadline", inApp: true, push: true }] }))
      .rejects.toThrow(PermissionError);

    await defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: true, push: false }] });
    const [audit] = await raw<{ before: { kinds: { kind: string; push: boolean }[] }; after: { kinds: { kind: string; push: boolean }[] } }[]>`
      select "before", "after" from public.audit_log
       where organization_id = ${ORG} and action = 'staff_notice_defaults.changed' order by created_at desc limit 1`;
    expect(audit!.before.kinds.find((k) => k.kind === "task_deadline")!.push).toBe(true);
    expect(audit!.after.kinds.find((k) => k.kind === "task_deadline")!.push).toBe(false);
  });
});

run("a deadline about to be missed", () => {
  let jobId = "";

  beforeAll(async () => {
    if (!url) return;
    const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Clock Customer') returning id`;
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '1 Clock Ct', 'Austin', 'TX', '78701') returning id`;
    const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 9001, ${c!.id}, ${p!.id}, 'scheduled', 'Chiller down') returning id`;
    jobId = j!.id;
  });

  beforeEach(async () => {
    if (!url) return;
    await raw`delete from public.obligation where organization_id = ${ORG}`;
    await raw`delete from public.staff_notice where organization_id = ${ORG}`;
    await raw`delete from public.task where organization_id = ${ORG}`;
  });

  const aDeadline = (over: { escalateAt?: Date | null } = {}) => raw<{ id: string }[]>`
    insert into public.obligation (organization_id, kind, entity_type, entity_id, due_at, consequence, escalate_at)
    values (${ORG}, 'test.deadline', 'job', ${jobId}, now() + interval '2 hours', 'The client refuses a late visit.',
            ${over.escalateAt === undefined ? new Date(Date.now() - 60_000) : over.escalateAt})
    returning id`;

  it("tells the people who can deal with it, and not the ones who cannot open or answer it, once", async () => {
    await aDeadline();
    const swept = await obligations.sweep(owner());
    expect(swept.escalated).toBe(1);

    const [task] = await raw<{ id: string; title: string }[]>`select id, title from public.task where organization_id = ${ORG}`;
    for (const who of [OWNER, OFFICE]) {
      const told = await noticesFor(who, "task_deadline");
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ href: `/tasks/${task!.id}`, entity_type: "task", in_app: true });
      expect(told[0]!.title).toBe(`Deadline close: ${task!.title}`);
      expect(told[0]!.body).toMatch(/^Due \d{4}-\d{2}-\d{2} at \d{2}:\d{2}\. The client refuses a late visit\.$/);
    }
    /** The dispatcher holds no task permission and the technician cannot write tasks. */
    expect(await noticesFor(DISPATCH, "task_deadline")).toHaveLength(0);
    expect(await noticesFor(TECH, "task_deadline")).toHaveLength(0);

    /** Looked at again, nobody is told twice. */
    expect((await obligations.sweep(owner())).escalated).toBe(0);
    expect(await noticesFor(OWNER, "task_deadline")).toHaveLength(1);
  });

  it("does not tell anybody about a deadline that is not close yet, or one somebody already met", async () => {
    await aDeadline({ escalateAt: new Date(Date.now() + 3600_000) });
    await obligations.sweep(owner());
    expect(await noticesFor(OWNER, "task_deadline")).toHaveLength(0);

    await raw`delete from public.obligation where organization_id = ${ORG}`;
    await raw`insert into public.obligation (organization_id, kind, entity_type, entity_id, due_at, escalate_at, state)
      values (${ORG}, 'test.deadline', 'job', ${jobId}, now() + interval '2 hours', now() - interval '1 minute', 'satisfied')`;
    await obligations.sweep(owner());
    expect(await noticesFor(OWNER, "task_deadline")).toHaveLength(0);
  });

  it("goes where each person said, so one who keeps it off their bell has the row and nothing on the bell", async () => {
    await notices.setSwitches(as(OFFICE, ["office_manager"]), {
      kinds: [{ kind: "task_deadline", inApp: false, push: false, text: false }],
    });
    await aDeadline();
    await obligations.sweep(owner());
    expect((await noticesFor(OFFICE, "task_deadline"))[0]).toMatchObject({ in_app: false });
    expect((await notices.list(as(OFFICE, ["office_manager"]))).notices.filter((n) => n.kind === "task_deadline")).toHaveLength(0);
    expect((await notices.list(owner())).notices.filter((n) => n.kind === "task_deadline")).toHaveLength(1);
    await raw`delete from public.staff_notice_setting where organization_id = ${ORG} and user_id = ${OFFICE}`;
  });

  it("goes where the company started a new person, until they change it themselves", async () => {
    await defaults.setDefaults(owner(), { kinds: [{ kind: "task_deadline", inApp: false, push: false }] });
    await person(NEWBIE, "office_manager", "Nell");
    await aDeadline();
    await obligations.sweep(owner());
    expect((await noticesFor(NEWBIE, "task_deadline"))[0]).toMatchObject({ in_app: false });
    expect((await noticesFor(OFFICE, "task_deadline"))[0]).toMatchObject({ in_app: true });
    await raw`delete from public.staff_notice_default where organization_id = ${ORG}`;
    await raw`delete from public.staff_notice_setting where organization_id = ${ORG} and user_id = ${NEWBIE}`;
    await raw`delete from public.staff_notice where organization_id = ${ORG} and user_id = ${NEWBIE}`;
    await raw`delete from public.membership where organization_id = ${ORG} and user_id = ${NEWBIE}`;
  });
});
