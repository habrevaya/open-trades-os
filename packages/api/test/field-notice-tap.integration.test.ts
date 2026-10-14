import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as notices from "../src/services/staff-notices";
import * as tasks from "../src/services/tasks";
import * as fieldOps from "../src/services/field";
import type { ServiceContext } from "../src/services/context";
import type { PushMessage, PushProvider, PushReceipt, PushTicket } from "../src/push/provider";
import { fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * A NOTICE TAPPED ON THE PHONE
 *
 * What the phone is sent with a notice about somebody's own work, so a tap can
 * open what it is about, and the mark that comes back when it was opened: a
 * field queue operation (`notice.read`), so it lands from a basement too. What
 * is pinned: the push names the kind and id of the record and the page the bell
 * would open and nothing the bell does not show; opening marks only the
 * person's own notice; opening twice, or a retry of the same operation, is the
 * first answer again; and somebody else's notice, or a notice that is gone, is
 * left alone without telling the phone anything it could use to learn whose it
 * was.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("notice-tap:org");
const OWNER = fixtureId("notice-tap:owner");
const OFFICE = fixtureId("notice-tap:office");
const RAY = fixtureId("notice-tap:ray");
const RAY_TOKEN = "ExponentPushToken[raytapraytapraytap01]";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const ray = () => as(RAY, ["technician"], { technicianId: rayTech });
let rayTech = "";
let rayDevice = "";
let sequence = 0;

class FakePush implements PushProvider {
  readonly name = "fake";
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    return messages.map((m) => { this.sent.push(m); return { ok: true as const, id: `ticket-${this.sent.length}` }; });
  }
  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Object.fromEntries(ids.map((id) => [id, { ok: true as const }]));
  }
}

async function person(userId: string, role: string, email: string, name: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}) returning id`;
  return m!.id;
}

/** Sends one `notice.read` the way the phone does, and answers what the server said of it. */
async function opened(
  noticeId: string | undefined, again: { clientId: string; sequence: number } = { clientId: crypto.randomUUID(), sequence: ++sequence },
) {
  const result = await fieldOps.sync(ray(), {
    deviceId: rayDevice,
    operations: [{
      clientId: again.clientId, sequence: again.sequence, kind: "notice.read",
      ...(noticeId ? { subjectId: noticeId } : {}),
      occurredAt: new Date().toISOString(), payload: {},
    }],
  });
  return result.results[0]!;
}

const readAt = async (noticeId: string) => {
  const [row] = await raw<{ read_at: Date | null }[]>`select read_at from public.staff_notice where id = ${noticeId}`;
  return row!.read_at;
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Tap Co", slug: "notice-tap-co" });
  await person(OFFICE, "office_manager", "office@notice-tap.test", "Oscar Office");
  const membership = await person(RAY, "technician", "ray@notice-tap.test", "Ray Nunez");
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership}, 'Ray Nunez') returning id`;
  rayTech = t!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${OFFICE}, ${RAY})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.staff_notice_delivery where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.device where organization_id = ${ORG}`;
  sequence = 0;
  rayDevice = (await fieldOps.register(ray(), { installationId: `ray-${crypto.randomUUID()}`, pushToken: RAY_TOKEN })).deviceId;
});

run("what a notice is sent with", () => {
  it("names the record's kind and id and the page the bell opens, and nothing else", async () => {
    const task = await tasks.create(owner(), { title: "Call Mrs Patel back", body: "Her number is in the notes", assigneeUserId: RAY });
    const [row] = await raw<{ id: string }[]>`select id from public.staff_notice where organization_id = ${ORG} and user_id = ${RAY}`;
    const push = new FakePush();
    await notices.noticesFor(db(), ORG, { push, raise: false });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.data).toEqual({
      noticeId: row!.id, kind: "task_assigned", href: `/tasks/${task.id}`, about: { type: "task", id: task.id },
    });
    // The words are the notice's own, which the lock screen shows; the task's body is not in the payload.
    expect(JSON.stringify(push.sent[0]!.data)).not.toContain("Patel");
  });

  it("is the same shape for a record the phone has no screen for", () => {
    expect(notices.pushData({
      noticeId: "n1", kind: "po_approval", href: "/purchasing/p1", entityType: "purchase_order", entityId: "p1",
    })).toEqual({ noticeId: "n1", kind: "po_approval", href: "/purchasing/p1", about: { type: "purchase_order", id: "p1" } });
  });
});

run("opening a notice on the phone", () => {
  it("marks it read on the bell, once, and a retry changes nothing", async () => {
    await tasks.create(owner(), { title: "Swap the filter", assigneeUserId: RAY });
    await tasks.create(owner(), { title: "Check the van", assigneeUserId: RAY });
    const rows = await raw<{ id: string }[]>`select id from public.staff_notice where user_id = ${RAY} order by created_at`;
    expect((await notices.list(ray())).unread).toBe(2);

    const sent = { clientId: crypto.randomUUID(), sequence: ++sequence };
    expect(await opened(rows[0]!.id, sent)).toMatchObject({ status: "applied", rejection: null });
    const first = await readAt(rows[0]!.id);
    expect(first).not.toBeNull();
    expect((await notices.list(ray())).unread).toBe(1);
    expect(await readAt(rows[1]!.id)).toBeNull();

    // The same operation sent again is the first answer, and the same notice opened again keeps its first time.
    expect(await opened(rows[0]!.id, sent)).toMatchObject({ status: "applied" });
    expect(await opened(rows[0]!.id)).toMatchObject({ status: "applied" });
    expect(await readAt(rows[0]!.id)).toEqual(first);
    expect((await notices.list(ray())).unread).toBe(1);
  });

  it("leaves somebody else's notice, and a notice that is gone, alone", async () => {
    await tasks.create(owner(), { title: "Chase the permit", assigneeUserId: OFFICE });
    const [theirs] = await raw<{ id: string }[]>`select id from public.staff_notice where user_id = ${OFFICE}`;

    expect(await opened(theirs!.id)).toMatchObject({ status: "applied" });
    expect(await readAt(theirs!.id)).toBeNull();
    expect(await opened(crypto.randomUUID())).toMatchObject({ status: "applied" });
  });

  it("says in words when the operation names no notice", async () => {
    expect(await opened(undefined)).toMatchObject({ status: "rejected", rejection: "That names no notice." });
  });
});
