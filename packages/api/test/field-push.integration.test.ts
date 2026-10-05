import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { time, type Actor } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as fieldDevices from "../src/services/field-devices";
import * as dispatchSvc from "../src/services/dispatch";
import * as crews from "../src/services/crews";
import * as jobs from "../src/services/jobs";
import * as push from "../src/services/push";
import { announce, sideOf } from "../src/services/visit-notices";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { ExpoPushProvider, type PushMessage, type PushProvider, type PushReceipt, type PushTicket } from "../src/push/provider";
import { seedOrg, fixtureId, testDb, resetOrg } from "./helpers";

/**
 * TELLING THE TECHNICIAN'S PHONE THAT THEIR DAY CHANGED
 *
 * Driven from the office's own actions, the board putting a visit on
 * somebody's day and taking it off, through the event log, to the push pass
 * the worker runs, with the push service faked at its seam. What is pinned is
 * what a technician would notice: who is told, what it says, that nobody is
 * told twice, that a phone signed out or gone is not told at all, and that a
 * notice at eleven at night is quiet unless the work is that night.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("field-push:org");
const OWNER = fixtureId("field-push:owner");
const RAY = fixtureId("field-push:ray");
const SAM = fixtureId("field-push:sam");
const ZONE = "America/Chicago";
const RAY_TOKEN = "ExponentPushToken[rayrayrayrayrayray00]";
const SAM_TOKEN = "ExponentPushToken[samsamsamsamsamsam00]";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (userId: string, technicianId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId }, db: db(),
});

let rayTech = "";
let samTech = "";
let customerId = "";
let propertyId = "";

/** The push service, faked: records what it was handed and answers as told. */
class FakePush implements PushProvider {
  readonly name = "fake";
  sent: PushMessage[] = [];
  asked: string[] = [];
  answer: (message: PushMessage) => PushTicket = (message) => ({ ok: true, id: `ticket-${message.to}-${this.sent.length}` });
  receiptFor: (id: string) => PushReceipt | undefined = () => ({ ok: true });
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets = messages.map((m) => { this.sent.push(m); return this.answer(m); });
    return tickets;
  }
  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    this.asked.push(...ids);
    const out: Record<string, PushReceipt> = {};
    for (const id of ids) {
      const receipt = this.receiptFor(id);
      if (receipt) out[id] = receipt;
    }
    return out;
  }
}

async function technician(userId: string, email: string, name: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return tech!.id as string;
}

/** A visit tomorrow afternoon with nobody on it, as the board sees new work. */
async function visit(windowStart = new Date(Date.now() + 26 * 3_600_000)) {
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId}, 'scheduled', 'No heat')
    returning id, number`;
  const [v] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'unassigned', ${windowStart}, ${new Date(windowStart.getTime() + 3 * 3_600_000)})
    returning id`;
  return { visitId: v!.id as string, jobNumber: job!.number as number };
}

/** Every pending change read and sent, as the worker would on its next pass. */
async function pass(provider: FakePush, now = new Date()) {
  return push.pushFor(db(), ORG, { provider, now: () => now });
}

/** Read the log up to now without sending, so each test starts from a quiet log. */
async function drainQuietly() {
  await push.pushFor(db(), ORG, { provider: new FakePush() });
  await raw`delete from public.push_delivery where organization_id = ${ORG}`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Push Co", slug: "field-push" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  rayTech = await technician(RAY, "ray@field-push.test", "Ray Nunez");
  samTech = await technician(SAM, "sam@field-push.test", "Sam Ortiz");

  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Nina Patel') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '88 Ridge Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${RAY}, ${SAM})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.push_delivery where organization_id = ${ORG}`;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'quietHours' where id = ${ORG}`;
  await fieldOps.register(as(RAY, rayTech), { installationId: `ray-${crypto.randomUUID()}`, pushToken: RAY_TOKEN });
  await fieldOps.register(as(SAM, samTech), { installationId: `sam-${crypto.randomUUID()}`, pushToken: SAM_TOKEN });
  await drainQuietly();
});

run("a change to somebody's day reaches their phone", () => {
  it("tells the technician a visit was put on their day, once, with the job and the time", async () => {
    const { visitId, jobNumber } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });

    const provider = new FakePush();
    const result = await pass(provider);

    expect(result.queued).toBe(1);
    expect(provider.sent).toHaveLength(1);
    const [message] = provider.sent;
    expect(message!.to).toBe(RAY_TOKEN);
    expect(message!.title).toBe("New job on your day");
    expect(message!.body).toMatch(new RegExp(`^Job ${jobNumber}, Nina Patel\\. `));
    expect(message!.data).toEqual({ visitId, kind: "assigned" });

    const [row] = await raw`select status, ticket_id, sent_at from public.push_delivery
      where organization_id = ${ORG} and visit_id = ${visitId}`;
    expect(row!.status).toBe("sent");
    expect(row!.ticket_id).toBe(`ticket-${RAY_TOKEN}-1`);

    // The next pass, and a second worker reading the same log, send nothing more.
    const again = new FakePush();
    await pass(again);
    await raw`update public.event_cursor set last_sequence = 0
      where organization_id = ${ORG} and consumer = 'push'`;
    await pass(again);
    expect(again.sent).toHaveLength(0);
  });

  it("tells the person taken off it and the person put on it, each their own news", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    await pass(new FakePush());

    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [samTech] });
    const provider = new FakePush();
    await pass(provider);

    const byToken = new Map(provider.sent.map((m) => [m.to, m]));
    expect(byToken.get(RAY_TOKEN)?.title).toBe("Job taken off your day");
    expect(byToken.get(SAM_TOKEN)?.title).toBe("New job on your day");
    expect(provider.sent).toHaveLength(2);
  });

  it("tells the people on a visit that moved, and says both times", async () => {
    const start = new Date(Date.now() + 26 * 3_600_000);
    const { visitId } = await visit(start);
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    await pass(new FakePush());

    const later = new Date(start.getTime() + 24 * 3_600_000);
    await inTenant(owner(), async (tx) => {
      const before = (await sideOf(tx, visitId))!;
      await tx.execute(sql`update public.visit set window_start = ${later.toISOString()}::timestamptz where id = ${visitId}`);
      await announce(tx, owner(), visitId, before);
    });

    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.title).toBe("Job moved");
    expect(provider.sent[0]!.body).toMatch(/: now .+ \(was .+\)\.$/);
  });

  it("tells everybody who was on a cancelled visit not to go", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech, samTech] });
    await pass(new FakePush());

    await inTenant(owner(), async (tx) => {
      const before = (await sideOf(tx, visitId))!;
      await tx.execute(sql`update public.visit set status = 'cancelled' where id = ${visitId}`);
      await tx.execute(sql`delete from public.visit_assignment where visit_id = ${visitId}`);
      await announce(tx, owner(), visitId, before);
    });

    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent.map((m) => m.title)).toEqual(["Job cancelled", "Job cancelled"]);
    expect(new Set(provider.sent.map((m) => m.to))).toEqual(new Set([RAY_TOKEN, SAM_TOKEN]));
    expect(provider.sent[0]!.body).toMatch(/is cancelled\. Do not go\.$/);
  });
});

run("quiet hours", () => {
  /** A quiet window that is open right now in the company's zone, whatever the time the test runs. */
  async function quietNow() {
    const hour = Math.floor(time.minutesInDay(new Date(), ZONE) / 60);
    await raw`update public.organization
      set settings = settings || ${raw.json({ quietHours: { startHour: hour, endHour: (hour + 3) % 24 } } as never)}
      where id = ${ORG}`;
  }

  it("sends a change to work after the quiet hours without a sound", async () => {
    await quietNow();
    const { visitId } = await visit(new Date(Date.now() + 3 * 24 * 3_600_000));
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.quiet).toBe(true);
    const [row] = await raw`select quiet from public.push_delivery where visit_id = ${visitId}`;
    expect(row!.quiet).toBe(true);
  });

  it("rings for work that starts inside the quiet hours", async () => {
    await quietNow();
    const { visitId } = await visit(new Date(Date.now() + 30 * 60_000));
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent[0]!.quiet).toBe(false);
  });

  it("is what Expo is asked for: no sound and a passive notice, or the loud channel", () => {
    const fetched: unknown[] = [];
    const expo = new ExpoPushProvider({
      fetch: (async (_url: string, init: RequestInit) => {
        fetched.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: [{ status: "ok", id: "a" }, { status: "ok", id: "b" }] }));
      }) as unknown as typeof fetch,
    });
    return expo.send([
      { to: RAY_TOKEN, title: "t", body: "b", data: {}, quiet: true },
      { to: SAM_TOKEN, title: "t", body: "b", data: {}, quiet: false },
    ]).then((tickets) => {
      expect(tickets).toEqual([{ ok: true, id: "a" }, { ok: true, id: "b" }]);
      const [quiet, loud] = fetched[0] as Array<Record<string, unknown>>;
      expect(quiet).toMatchObject({ priority: "normal", channelId: "visits-quiet", interruptionLevel: "passive" });
      expect(quiet).not.toHaveProperty("sound");
      expect(loud).toMatchObject({ sound: "default", priority: "high", channelId: "visits" });
    });
  });
});

run("phones that cannot be told", () => {
  it("tells nobody on a phone that signed out", async () => {
    const rayDevice = (await raw`select id from public.device where technician_id = ${rayTech}`)[0]!.id as string;
    await fieldDevices.signOut(as(RAY, rayTech), { id: rayDevice });
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    const result = await pass(provider);
    expect(result.queued).toBe(0);
    expect(provider.sent).toHaveLength(0);
  });

  it("forgets the token when the push service says the app is gone, at send or at receipt", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech, samTech] });

    const provider = new FakePush();
    provider.answer = (m) => m.to === SAM_TOKEN
      ? { ok: false, error: "The app is no longer on this phone.", gone: true, retryable: false }
      : { ok: true, id: "ray-ticket" };
    const result = await pass(provider);
    expect(result).toMatchObject({ sent: 1, failed: 1, forgotten: 1 });
    const [sam] = await raw`select push_token from public.device where technician_id = ${samTech}`;
    expect(sam!.push_token).toBeNull();

    // A quarter of an hour later the receipt for Ray's says the same thing.
    provider.receiptFor = () => ({ ok: false, error: "The app is no longer on this phone.", gone: true });
    const later = await pass(provider, new Date(Date.now() + 20 * 60_000));
    expect(provider.asked).toEqual(["ray-ticket"]);
    expect(later.forgotten).toBe(1);
    const [ray] = await raw`select push_token from public.device where technician_id = ${rayTech}`;
    expect(ray!.push_token).toBeNull();
    const audits = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'device.push_forgotten'`;
    expect(audits[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("tries again when the push service does not answer, and gives up after five", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    provider.send = async () => { throw new Error("connect ECONNREFUSED"); };
    for (let i = 0; i < push.MAX_ATTEMPTS; i++) await pass(provider);
    const [row] = await raw`select status, attempts, error from public.push_delivery where visit_id = ${visitId}`;
    expect(row).toMatchObject({ status: "failed", attempts: push.MAX_ATTEMPTS, error: "connect ECONNREFUSED" });
  });

  it("skips a change read long after it was made, rather than buzzing about old news", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    await raw`update public.domain_event set occurred_at = now() - interval '13 hours'
      where organization_id = ${ORG} and entity_id = ${visitId}`;
    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent).toHaveLength(0);
  });

  it("takes a handset's token off the person who used it before", async () => {
    await fieldOps.register(as(SAM, samTech), { installationId: `sam-${crypto.randomUUID()}`, pushToken: RAY_TOKEN });
    const holders = await raw`select technician_id from public.device
      where organization_id = ${ORG} and push_token = ${RAY_TOKEN}`;
    expect(holders.map((h) => h.technician_id)).toEqual([samTech]);
  });

  it("refuses something that is not a push token", async () => {
    await expect(fieldOps.register(as(RAY, rayTech), { installationId: `ray-${crypto.randomUUID()}`, pushToken: "not-a-token" }))
      .rejects.toThrow(ConflictError);
  });
});

run("the worker's own pass", () => {
  it("finds this company through the cross tenant door and sends with the provider it is given", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    const results = await push.pushPass(db(), { provider });
    expect(results.some((r) => r.organizationId === ORG)).toBe(true);
    expect(provider.sent.some((m) => m.to === RAY_TOKEN && m.data["visitId"] === visitId)).toBe(true);
  });
});

run("a crew's work reaches each member's phone", () => {
  /** A crew of Ray, who leads, and Sam. */
  async function crewOfTwo(): Promise<string> {
    const crew = await crews.create(owner(), { name: `Install crew ${crypto.randomUUID().slice(0, 6)}` });
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: rayTech, isLead: true }, { technicianId: samTech }] });
    return crew.id;
  }

  it("tells every member when a visit is sent to the crew, and when it is cancelled with its job", async () => {
    const crewId = await crewOfTwo();
    const { visitId } = await visit();
    await crews.assign(owner(), { id: visitId, crewId });
    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent.map((m) => m.title)).toEqual(["New job on your day", "New job on your day"]);
    expect(new Set(provider.sent.map((m) => m.to))).toEqual(new Set([RAY_TOKEN, SAM_TOKEN]));

    const [row] = await raw`select job_id from public.visit where id = ${visitId}`;
    await jobs.update(owner(), { id: row!.job_id, status: "cancelled", cancelVisits: true });
    const cancelled = new FakePush();
    await pass(cancelled);
    expect(cancelled.sent.map((m) => m.title)).toEqual(["Job cancelled", "Job cancelled"]);
    expect(new Set(cancelled.sent.map((m) => m.to))).toEqual(new Set([RAY_TOKEN, SAM_TOKEN]));
  });

  it("tells the members a crew visit moved", async () => {
    const crewId = await crewOfTwo();
    const start = new Date(Date.now() + 26 * 3_600_000);
    const { visitId } = await visit(start);
    await crews.assign(owner(), { id: visitId, crewId });
    await pass(new FakePush());
    await inTenant(owner(), async (tx) => {
      const before = (await sideOf(tx, visitId))!;
      await tx.execute(sql`update public.visit set window_start = ${new Date(start.getTime() + 864e5).toISOString()}::timestamptz where id = ${visitId}`);
      await announce(tx, owner(), visitId, before);
    });
    const provider = new FakePush();
    await pass(provider);
    expect(provider.sent.map((m) => m.title)).toEqual(["Job moved", "Job moved"]);
  });

  it("hands a crew's visit to one person: off the crew, the others told it is not theirs", async () => {
    const crewId = await crewOfTwo();
    const { visitId } = await visit();
    await crews.assign(owner(), { id: visitId, crewId });
    await pass(new FakePush());

    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const [row] = await raw`select crew_id from public.visit where id = ${visitId}`;
    expect(row!.crew_id).toBeNull();
    const provider = new FakePush();
    await pass(provider);
    // Ray keeps it, now as his own, so he hears nothing new; Sam hears it came off his day.
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ to: SAM_TOKEN, title: "Job taken off your day" });
  });

  it("takes a visit off the person who had it when it is sent to a crew", async () => {
    const crewId = await crewOfTwo();
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [samTech] });
    await crews.assign(owner(), { id: visitId, crewId });
    expect(await raw`select id from public.visit_assignment where visit_id = ${visitId}`).toHaveLength(0);
  });
});

run("a notice that never reached anybody is put in front of the office", () => {
  const officeTasks = () => raw<{ title: string; body: string; entity_type: string; entity_id: string; priority: string }[]>`
    select title, body, entity_type, entity_id, priority from public.task
     where organization_id = ${ORG} and title like '%phone was not told%'`;

  beforeEach(async () => {
    await raw`delete from public.task where organization_id = ${ORG}`;
  });

  it("raises one task on the visit once every try has failed, and only once", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    provider.send = async () => { throw new Error("connect ECONNREFUSED"); };
    for (let i = 0; i < push.MAX_ATTEMPTS - 1; i++) await pass(provider);
    expect(await officeTasks()).toHaveLength(0);

    const last = await pass(provider);
    expect(last.tasks).toBe(1);
    const [task] = await officeTasks();
    expect(task).toMatchObject({ entity_type: "visit", entity_id: visitId, priority: "high" });
    expect(task!.title).toMatch(/^Ray Nunez's phone was not told: New job on your day/);
    expect(task!.body).toMatch(/connect ECONNREFUSED\)\. Call Ray Nunez to tell them\.$/);

    await pass(provider);
    expect(await officeTasks()).toHaveLength(1);
  });

  it("raises nothing when another of the person's phones got it", async () => {
    await fieldOps.register(as(RAY, rayTech), { installationId: `ray-${crypto.randomUUID()}`, pushToken: "ExponentPushToken[raysecondphone000000]" });
    await drainQuietly();
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    const provider = new FakePush();
    provider.answer = (m) => m.to === RAY_TOKEN
      ? { ok: false, error: "The app is no longer on this phone.", gone: true, retryable: false }
      : { ok: true, id: "second-phone" };
    await pass(provider);
    expect(await officeTasks()).toHaveLength(0);
  });

  it("raises it when the receipt says the one phone that took it never showed it", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [samTech] });
    const provider = new FakePush();
    await pass(provider);
    expect(await officeTasks()).toHaveLength(0);
    provider.receiptFor = () => ({ ok: false, error: "Message rate exceeded.", gone: false });
    await pass(provider, new Date(Date.now() + 20 * 60_000));
    const [task] = await officeTasks();
    expect(task!.title).toMatch(/^Sam Ortiz's phone was not told/);
  });

  it("says nothing about a phone somebody signed out on purpose", async () => {
    const { visitId } = await visit();
    await dispatchSvc.assign(owner(), { id: visitId, technicianIds: [rayTech] });
    await pass(new FakePush());
    await raw`update public.push_delivery set status = 'queued' where visit_id = ${visitId}`;
    await raw`update public.device set push_token = null where technician_id = ${rayTech}`;
    await pass(new FakePush());
    expect(await officeTasks()).toHaveLength(0);
  });
});
