import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { field, PermissionError, type Actor } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as dispatchSvc from "../src/services/dispatch";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A day in the field, against a real database.
 *
 * The core module proves the ordering and conflict rules without a database.
 * This proves the rest: that a whole offline day lands in one transaction,
 * that a resend does not double anything, and that the states core reasons
 * about are the states the schema actually has.
 */
const url = process.env.DATABASE_URL;

if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}

const run = url ? describe : describe.skip;

const ORG = fixtureId("field/org");
const USER = fixtureId("field/user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctxFor = (roles: Actor["roles"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});
const tech = () => ctxFor(["technician"]);

let technicianId = "";
let customerId = "";
let propertyId = "";

/** A fresh scheduled visit, so each test starts from a known state. */
async function makeVisit(status = "dispatched") {
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
            'scheduled', 'Condenser not cooling') returning id`;
  const [visit] = await raw`insert into public.visit
    (organization_id, job_id, status) values (${ORG}, ${job!.id}, ${status}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
    values (${ORG}, ${visit!.id}, ${technicianId})`;
  return { jobId: job!.id, visitId: visit!.id };
}

const uuid = () => crypto.randomUUID();

/**
 * A device per test, numbering from one.
 *
 * The first version of this file shared one device and gave each test a
 * distant sequence block: 900, 2000, 3000. Every one of those is a gap, so
 * everything after the first test was correctly held and nothing applied. A
 * real device numbers contiguously from one and never skips, so the fixture
 * should too.
 */
async function freshDevice(): Promise<string> {
  const r = await fieldOps.register(tech(), { installationId: `install-${uuid()}` });
  return r.deviceId;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Field Co", slug: "field-co" });

  const [membership] = await raw`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician
    (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  technicianId = t!.id;

  /**
   * A number we can send from and a customer who can be texted.
   *
   * Added when "on my way" started actually sending. Before that it wrote a
   * row and returned a tracking link for a customer with no phone on file,
   * and the test below asserted on the link, which is why nobody noticed that
   * no text existed to put it in.
   */
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559970', 'main', true)`;
  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Nina Patel', '+15125550140') returning id`;
  customerId = c!.id;
  await raw`insert into public.communication_consent
    (organization_id, address, channel, purpose, state, method, captured_at)
    values (${ORG}, '+15125550140', 'sms', 'transactional', 'granted', 'verbal', now())`;
  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '88 Ridge Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;

  // Each test registers its own device via freshDevice(), numbering from one,
  // because that is how a real phone behaves and because a shared device makes
  // every later test sit behind a sequence gap.
});

afterAll(async () => { if (raw) await raw.end(); });

run("the states core reasons about", () => {
  /**
   * The reason this test exists. An earlier version of the core module named
   * two visit states the schema does not have, and every unit test passed:
   * the transition table simply never matched, so every operation took the
   * "no current state" path and applied unconditionally. Nothing was red.
   */
  it("are exactly the states the database has", async () => {
    const rows = await raw<{ label: string }[]>`
      select e.enumlabel as label
      from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'visit_status'
      order by e.enumsortorder`;

    expect([...field.VISIT_STATES].sort()).toEqual(rows.map((r) => r.label).sort());
  });

  it("names a real column for every report state", async () => {
    const rows = await raw<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'service_report'
        and column_name in ('submitted_at', 'published_at')`;
    expect(rows.map((r) => r.column_name).sort()).toEqual(["published_at", "submitted_at"]);
  });
});

run("registering a device", () => {
  it("gives a new install a sequence of zero", async () => {
    const r = await fieldOps.register(tech(), { installationId: `install-${uuid()}` });
    expect(r.lastSequence).toBe(0);
  });

  /**
   * A reinstall that kept its installation id must not start again at one.
   * Every operation it resent would collide with one already stored, every
   * collision would look like a replay, and a whole day would be silently
   * discarded as already applied.
   */
  it("resumes a reinstall at the sequence it reached", async () => {
    const installationId = `install-${uuid()}`;
    const first = await fieldOps.register(tech(), { installationId });

    await fieldOps.sync(tech(), {
      deviceId: first.deviceId,
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.note",
        subjectId: (await makeVisit()).visitId,
        occurredAt: new Date().toISOString(), payload: { text: "hello" },
      }],
    });

    const again = await fieldOps.register(tech(), { installationId });
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.lastSequence).toBe(1);
  });

  it("refuses an account that is not a technician", async () => {
    const other = fixtureId("field/office-user");
    await raw`insert into public."user" (id, email) values (${other}, 'office@field.test')
      on conflict (id) do nothing`;
    await raw`insert into public.membership (organization_id, user_id, role)
      values (${ORG}, ${other}, 'admin') on conflict do nothing`;

    // Deliberately a role that HOLDS field:sync. The point is that holding the
    // permission is not enough: there has to be a technician record behind the
    // account, and a permission check alone would let an office user register
    // a phone that no schedule could ever be sent to.
    const notATechnician: ServiceContext = {
      actor: { userId: other, organizationId: ORG, roles: ["technician"] }, db: db(),
    };
    await expect(fieldOps.register(notATechnician, { installationId: `install-${uuid()}` }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses a role without field:sync", async () => {
    await expect(fieldOps.register(ctxFor(["readonly"]), { installationId: `install-${uuid()}` }))
      .rejects.toThrow(PermissionError);
  });
});

run("a full offline day", () => {
  it("lands eleven queued operations in one call", async () => {
    const { visitId } = await makeVisit();
    const day = new Date("2026-04-02T00:00:00Z").getTime();
    const at = (h: number, min: number) =>
      new Date(day + h * 3600_000 + min * 60_000).toISOString();

    const ops = [
      { kind: "timeclock.punch_in", sequence: 1, occurredAt: at(7, 2),
        payload: { technicianId, classification: "journeyman", workClassCode: "5183" } },
      { kind: "visit.en_route", sequence: 2, occurredAt: at(7, 40), subjectId: visitId },
      { kind: "visit.arrive", sequence: 3, occurredAt: at(8, 5), subjectId: visitId },
      { kind: "visit.start", sequence: 4, occurredAt: at(8, 8), subjectId: visitId },
      { kind: "attachment.attach", sequence: 5, occurredAt: at(8, 30), subjectId: visitId,
        payload: { uploadId: uuid(), contentType: "image/jpeg", byteSize: 2_400_000 } },
      { kind: "visit.note", sequence: 6, occurredAt: at(8, 45), subjectId: visitId,
        payload: { text: "Compressor contactor pitted" } },
      { kind: "visit.complete", sequence: 7, occurredAt: at(9, 36), subjectId: visitId },
      { kind: "timeclock.punch_out", sequence: 8, occurredAt: at(16, 20),
        payload: { technicianId } },
    ].map((o) => ({ clientId: uuid(), payload: {}, ...o })) as Parameters<
      typeof fieldOps.sync
    >[1]["operations"];

    const result = await fieldOps.sync(tech(), { deviceId: await freshDevice(), operations: ops });

    expect(result.results).toHaveLength(8);
    expect(result.results.every((r) => r.status === "applied")).toBe(true);
    expect(result.awaiting).toEqual([]);

    const [visit] = await raw`select status, en_route_at, arrived_at, completed_at,
      technician_notes from public.visit where id = ${visitId}`;
    expect(visit!.status).toBe("completed");
    expect(visit!.en_route_at).not.toBeNull();
    expect(visit!.arrived_at).not.toBeNull();
    expect(visit!.completed_at).not.toBeNull();
    expect(visit!.technician_notes).toContain("contactor");

    // The punch closed against its own punch in, and the classification
    // captured at the punch survived the whole trip.
    const [entry] = await raw`select minutes, classification, work_class_code
      from public.timeclock_entry
      where organization_id = ${ORG} and technician_id = ${technicianId}
      order by started_at desc limit 1`;
    expect(entry!.minutes).toBe(558);
    expect(entry!.classification).toBe("journeyman");
    expect(entry!.work_class_code).toBe("5183");

    // The photo is recorded before its bytes exist, so the report does not
    // look empty while an upload finishes in a van.
    const [upload] = await raw`select status from public.field_upload
      where organization_id = ${ORG} order by created_at desc limit 1`;
    expect(upload!.status).toBe("queued");
  });

  it("tells the customer what happened, as it happened", async () => {
    const { visitId, jobId } = await makeVisit();
    const now = Date.now();
    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [
        { clientId: uuid(), sequence: 1, kind: "visit.en_route", subjectId: visitId,
          occurredAt: new Date(now - 3600_000).toISOString(), payload: {} },
        { clientId: uuid(), sequence: 2, kind: "visit.arrive", subjectId: visitId,
          occurredAt: new Date(now - 3000_000).toISOString(), payload: {} },
      ],
    });

    const events = await raw`select kind, is_customer_visible from public.portal_event
      where job_id = ${jobId} order by occurred_at`;
    expect(events.map((e) => e.kind)).toEqual(["on_the_way", "arrived"]);
    expect(events.every((e) => e.is_customer_visible)).toBe(true);
  });

  /**
   * ARRIVING CLOSES THE NOTICE THAT PROMISED IT.
   *
   * `arrival_notice.arrived_at` was read by the customer portal and written
   * by nothing. The portal shows the estimate only while a notice is open,
   * so a technician who arrived left one open forever and the customer kept
   * being told somebody was twenty minutes away from a house they were
   * standing in.
   */
  it("closes the on-my-way notice when the technician arrives", async () => {
    const { visitId } = await makeVisit();
    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", etaMinutes: 20, includeTracking: false });

    const [before] = await raw<{ id: string; arrived_at: Date | null }[]>`
      select id, arrived_at from public.arrival_notice where visit_id = ${visitId}`;
    /** The notice has to exist, or the assertion below passes on nothing. */
    expect(before).toBeDefined();
    expect(before!.arrived_at).toBeNull();

    const arrivedAt = new Date(Date.now() - 600_000);
    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.arrive", subjectId: visitId,
        occurredAt: arrivedAt.toISOString(), payload: {},
      }],
    });

    const [after] = await raw<{ arrived_at: Date | null }[]>`
      select arrived_at from public.arrival_notice where visit_id = ${visitId}`;
    expect(after!.arrived_at).not.toBeNull();
    /**
     * Stamped from the operation's own time, not the clock. The phone
     * records when it happened and syncs later, and a notice closed at
     * upload time would say the technician arrived when the signal came back
     * rather than when they knocked.
     */
    expect(after!.arrived_at!.getTime()).toBe(arrivedAt.getTime());
  });
});

run("the connection coming and going", () => {
  it("treats a resent batch as already done", async () => {
    const { visitId } = await makeVisit();
    const ops = [{
      clientId: uuid(), sequence: 1, kind: "visit.note" as const, subjectId: visitId,
      occurredAt: new Date().toISOString(), payload: { text: "First pass" },
    }];

    const device = await freshDevice();
    const first = await fieldOps.sync(tech(), { deviceId: device, operations: ops });
    const second = await fieldOps.sync(tech(), { deviceId: device, operations: ops });

    expect(first.results[0]!.status).toBe("applied");
    expect(second.results[0]!.status).toBe("applied");

    // One row, not two. A note appended twice would be visible to the office.
    const counted = await raw<{ n: number }[]>`select count(*)::int as n
      from public.field_operation where client_id = ${ops[0]!.clientId}`;
    expect(counted[0]!.n).toBe(1);
  });

  it("holds operations behind a gap instead of rejecting the batch", async () => {
    const { visitId } = await makeVisit();
    const base = 1;
    const result = await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [base, base + 1, base + 3].map((sequence) => ({
        clientId: uuid(), sequence, kind: "visit.note" as const, subjectId: visitId,
        occurredAt: new Date().toISOString(), payload: { text: `op ${sequence}` },
      })),
    });

    const held = result.results.filter((r) => r.status === "held");
    expect(held).toHaveLength(1);
    expect(result.awaiting).toContain(base + 2);
  });

  it("refuses a revoked device", async () => {
    const installationId = `install-${uuid()}`;
    const { deviceId: doomed } = await fieldOps.register(tech(), { installationId });
    await raw`update public.device set revoked_at = now() where id = ${doomed}`;

    await expect(fieldOps.sync(tech(), {
      deviceId: doomed,
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.note", subjectId: (await makeVisit()).visitId,
        occurredAt: new Date().toISOString(), payload: { text: "x" },
      }],
    })).rejects.toThrow(ConflictError);
  });
});

run("when the office moved while the phone was underground", () => {
  /**
   * The case the whole design exists for. A dispatcher cancels a visit. The
   * technician, with no signal, does the work and completes it. Both of those
   * are true and a person needs to see both.
   */
  it("records work done on a visit that was cancelled, and flags it", async () => {
    const { visitId, jobId } = await makeVisit("cancelled");

    const result = await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.complete", subjectId: visitId,
        occurredAt: new Date().toISOString(), payload: {},
      }],
    });

    expect(result.results[0]!.status).toBe("conflicted");
    expect(result.results[0]!.conflict).toMatch(/cancelled/);

    // The cancellation stays visible rather than being overwritten by a
    // plain completion, which would hide that somebody was sent to a job the
    // office had called off.
    const [visit] = await raw`select status, completed_at from public.visit where id = ${visitId}`;
    expect(visit!.status).toBe("completed_after_cancellation");
    expect(visit!.completed_at).not.toBeNull();

    // And the customer is not told the work is complete on a job they were
    // told was cancelled. The office deals with that one.
    const events = await raw`select is_customer_visible from public.portal_event
      where job_id = ${jobId}`;
    expect(events.every((e) => e.is_customer_visible === false)).toBe(true);
  });

  it("puts the conflict in a queue a person works", async () => {
    const { visitId } = await makeVisit("cancelled");
    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.arrive", subjectId: visitId,
        occurredAt: new Date().toISOString(), payload: {},
      }],
    });

    const queue = await fieldOps.conflicts(ctxFor(["office_manager"]), { limit: 50, includeResolved: false });
    expect(queue.data.length).toBeGreaterThan(0);
    expect(queue.data[0]!.technicianName).toBe("Ray Nunez");
  });

  it("takes a conflict out of the queue when somebody deals with it", async () => {
    const { visitId } = await makeVisit("cancelled");
    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.arrive", subjectId: visitId,
        occurredAt: new Date().toISOString(), payload: {},
      }],
    });

    const before = await fieldOps.conflicts(ctxFor(["office_manager"]), { limit: 50, includeResolved: false });
    const target = before.data.find((c) => c.subjectId === visitId)!;

    await fieldOps.resolve(ctxFor(["office_manager"]), { id: target.id, note: "Billed as a trip charge" });

    const after = await fieldOps.conflicts(ctxFor(["office_manager"]), { limit: 50, includeResolved: false });
    expect(after.data.find((c) => c.id === target.id)).toBeUndefined();
  });
});

run("a phone whose clock is wrong", () => {
  it("clamps an occurrence in the future and keeps what was claimed", async () => {
    const { visitId } = await makeVisit();
    const clientId = uuid();
    const tomorrow = new Date(Date.now() + 26 * 3600_000).toISOString();

    const result = await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId, sequence: 1, kind: "visit.note", subjectId: visitId,
        occurredAt: tomorrow, payload: { text: "from the future" },
      }],
    });

    expect(result.results[0]!.clamped).toBe("future");

    const [row] = await raw`select occurred_at, claimed_at, clamped
      from public.field_operation where client_id = ${clientId}`;
    // A clamp is evidence. Keeping only the corrected value would make a
    // payroll dispute six weeks later unanswerable.
    expect(row!.clamped).toBe("future");
    expect(new Date(row!.claimed_at).toISOString()).toBe(tomorrow);
    expect(new Date(row!.occurred_at).getTime())
      .toBeLessThan(new Date(tomorrow).getTime());
  });
});

run("the dispatch board", () => {
  const office = () => ctxFor(["dispatcher"]);
  const day = "2026-05-12";
  const windowAt = (h: number) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`);

  async function scheduled(opts: { hour: number; assignTo?: string | undefined }) {
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Board test') returning id`;
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'scheduled',
              ${windowAt(opts.hour)}, ${windowAt(opts.hour + 2)}) returning id`;
    if (opts.assignTo) {
      await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
        values (${ORG}, ${visit!.id}, ${opts.assignTo})`;
    }
    return visit!.id;
  }

  it("separates a technician's day from the pile nobody has taken", async () => {
    await scheduled({ hour: 9, assignTo: technicianId });
    await scheduled({ hour: 13 });

    const result = await dispatchSvc.board(office(), { date: day });

    const ray = result.technicians.find((t) => t.id === technicianId)!;
    expect(ray.visits.length).toBeGreaterThan(0);
    expect(result.unassigned.length).toBeGreaterThan(0);
  });

  it("keeps an evening visit on the day it actually happens", async () => {
    /**
     * THE ONE THAT SHIPPED.
     *
     * The board bounded its day with `new Date(`${date}T00:00:00Z`)`, which
     * for a company in Chicago runs from seven the previous evening to seven
     * that evening. An emergency booked for nine at night was not on that
     * day's board at all, and the dispatcher looking at it that evening had
     * no way to know it existed.
     *
     * Nothing caught it because CI runs in UTC, where the two answers are
     * the same. The seeded demo company is in Austin, and the bug is visible
     * in a marketing screenshot: the caption describes an unassigned
     * emergency and the picture says "Nothing waiting".
     */
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Server room at 88F') returning id`;
    // Nine in the evening on the 12th in Chicago is two in the morning on the
    // 13th in UTC.
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'unassigned',
              ${new Date("2026-05-13T02:00:00Z")}, ${new Date("2026-05-13T04:00:00Z")})
      returning id`;

    const tonight = await dispatchSvc.board(office(), { date: day });
    expect(tonight.unassigned.map((v) => v.id)).toContain(visit!.id);

    // And not on tomorrow's, which is where it used to turn up.
    const tomorrow = await dispatchSvc.board(office(), { date: "2026-05-13" });
    expect(tomorrow.unassigned.map((v) => v.id)).not.toContain(visit!.id);
  });

  it("leaves the previous evening off today's board", async () => {
    // The other half of the same bug: seven to midnight the night before was
    // inside the UTC window for today, so it sat on the board all day.
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Last night') returning id`;
    // Nine in the evening on the 11th in Chicago.
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'unassigned',
              ${new Date("2026-05-12T02:00:00Z")}, ${new Date("2026-05-12T04:00:00Z")})
      returning id`;

    const today = await dispatchSvc.board(office(), { date: day });
    expect(today.unassigned.map((v) => v.id)).not.toContain(visit!.id);
    const yesterday = await dispatchSvc.board(office(), { date: "2026-05-11" });
    expect(yesterday.unassigned.map((v) => v.id)).toContain(visit!.id);
  });

  it("syncs a technician's evening visit to their phone", async () => {
    /**
     * The same bug on the truck. A phone asking for "this day, one day" was
     * handed a window that ended at seven in the evening local, so the last
     * call of the day was missing from the only screen that works without
     * signal, which is exactly when nobody can look it up another way.
     */
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Last call of the day') returning id`;
    // Ten at night on the 12th in Chicago.
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'dispatched',
              ${new Date("2026-05-13T03:00:00Z")}, ${new Date("2026-05-13T05:00:00Z")})
      returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;

    const result = await dispatchSvc.snapshot(tech(), {
      deviceId: await freshDevice(), from: day, days: 1,
    });
    expect(result.visits.map((v) => v.id)).toContain(visit!.id);
  });

  it("lets a dispatcher reorder an evening visit they can see", async () => {
    /**
     * Worse than the board, because the board at least failed by omission.
     * `reorder` bounds the same day to work out which visits belong to the
     * technician, so a card the dispatcher could see and drag came back
     * refused as somebody else's.
     */
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Evening call') returning id`;
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'dispatched',
              ${new Date("2026-05-13T01:00:00Z")}, ${new Date("2026-05-13T03:00:00Z")})
      returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;

    await expect(dispatchSvc.reorder(ctxFor(["dispatcher"]), {
      date: day, technicianId, visitIds: [visit!.id],
    })).resolves.toBeTruthy();
  });

  it("says a technician is off rather than leaving an unexplained gap", async () => {
    await raw`insert into public.time_off
      (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${technicianId}, ${windowAt(0)}, ${windowAt(23)}, true)`;

    const result = await dispatchSvc.board(office(), { date: day });
    const ray = result.technicians.find((t) => t.id === technicianId)!;
    // A blank column with no reason invites a dispatcher to fill it, and they will.
    expect(ray.timeOff).toBe(true);

    await raw`delete from public.time_off where organization_id = ${ORG}`;
  });

  it("marks a visit late once its own window has passed", async () => {
    const past = "2020-01-08";
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Long overdue') returning id`;
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'dispatched',
              ${new Date(`${past}T09:00:00Z`)}, ${new Date(`${past}T11:00:00Z`)}) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;

    const result = await dispatchSvc.board(office(), { date: past });
    const ray = result.technicians.find((t) => t.id === technicianId)!;
    const overdue = ray.visits.find((v) => v.id === visit!.id)!;
    // Computed once server side. Two clients computing it differently is how a
    // dispatcher and a manager end up arguing about which jobs are behind.
    expect(overdue.isLate).toBe(true);
  });

  it("does not call a completed visit late", async () => {
    const past = "2020-01-09";
    const [job] = await raw`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
              'scheduled', 'Done long ago') returning id`;
    const [visit] = await raw`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'completed',
              ${new Date(`${past}T09:00:00Z`)}, ${new Date(`${past}T11:00:00Z`)}) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;

    const result = await dispatchSvc.board(office(), { date: past });
    const ray = result.technicians.find((t) => t.id === technicianId)!;
    expect(ray.visits.find((v) => v.id === visit!.id)!.isLate).toBe(false);
  });

  it("replaces an assignment rather than adding to it", async () => {
    const visitId = await scheduled({ hour: 15, assignTo: technicianId });

    const [second] = await raw`insert into public.technician
      (organization_id, membership_id, display_name)
      values (${ORG}, (select id from public.membership
        where organization_id = ${ORG} and user_id = ${USER}), 'Dana Wu') returning id`;

    await dispatchSvc.assign(office(), { id: visitId, technicianIds: [second!.id] });

    const rows = await raw`select technician_id, is_lead from public.visit_assignment
      where visit_id = ${visitId}`;
    // The board's gesture is "these people, on this job". An add-only endpoint
    // makes removing somebody a second call that is easy to forget.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.technician_id).toBe(second!.id);
    expect(rows[0]!.is_lead).toBe(true);
  });

  it("moves an unassigned visit to dispatched, and leaves a moving one alone", async () => {

    const fresh = await scheduled({ hour: 16 });
    const first = await dispatchSvc.assign(office(), { id: fresh, technicianIds: [technicianId] });
    expect(first.status).toBe("dispatched");

    await raw`update public.visit set status = 'en_route' where id = ${fresh}`;
    const again = await dispatchSvc.assign(office(), { id: fresh, technicianIds: [technicianId] });
    // A technician already on the road stays on the road when the office adds
    // a second person to the job.
    expect(again.status).toBe("en_route");
  });

  it("refuses to reassign a visit that is finished", async () => {
    const visitId = await scheduled({ hour: 17 });
    await raw`update public.visit set status = 'completed' where id = ${visitId}`;

    await expect(dispatchSvc.assign(office(), { id: visitId, technicianIds: [technicianId] }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses a dispatcher without visit:dispatch", async () => {
    const visitId = await scheduled({ hour: 18 });
    await expect(dispatchSvc.assign(ctxFor(["readonly"]), {
      id: visitId, technicianIds: [technicianId],
    })).rejects.toThrow(PermissionError);
  });

  it("renumbers a whole day in one call", async () => {
    const a = await scheduled({ hour: 8, assignTo: technicianId });
    const b = await scheduled({ hour: 10, assignTo: technicianId });

    await dispatchSvc.reorder(ctxFor(["dispatcher"]), {
      technicianId, date: day, visitIds: [b, a],
    });

    const rows = await raw`select id, route_order from public.visit
      where id in (${a}, ${b}) order by route_order`;
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows.map((r) => r.route_order)).toEqual([1, 2]);
  });

  it("will not renumber somebody else's day through this endpoint", async () => {
    const mine = await scheduled({ hour: 11, assignTo: technicianId });
    const theirs = await scheduled({ hour: 12 });

    await expect(dispatchSvc.reorder(ctxFor(["dispatcher"]), {
      technicianId, date: day, visitIds: [mine, theirs],
    })).rejects.toThrow(ConflictError);
  });
});

run("on my way", () => {
  it("sends once, and a retry does not send a second", async () => {
    const { visitId } = await makeVisit();

    const first = await dispatchSvc.onMyWay(ctxFor(["technician"]), {
      id: visitId, channel: "sms", etaMinutes: 20, includeTracking: true,
    });
    expect(first.sent).toBe(true);
    expect(first.trackingUrl).toMatch(/\/j\//);

    await dispatchSvc.onMyWay(ctxFor(["technician"]), {
      id: visitId, channel: "sms", etaMinutes: 20, includeTracking: true,
    });

    const notices = await raw`select id from public.arrival_notice where visit_id = ${visitId}`;
    // The customer reads both. One is a courtesy and two is an annoyance.
    expect(notices).toHaveLength(1);

    /**
     * And one text. The notice count was the whole of this assertion while
     * the function sent nothing, so it proved only that the row was written
     * once.
     *
     * Scoped to THIS visit, not to the organization. Counting every outbound
     * message in the org read as "one text was sent" and measured "this
     * company has ever sent exactly one text", which held only while nothing
     * else in the file sent anything and broke the moment something did.
     */
    const messages = await raw`select m.id from public.message m
      join public.arrival_notice n on n.message_id = m.id
      where n.visit_id = ${visitId} and m.direction = 'outbound'`;
    expect(messages).toHaveLength(1);
  });

  it("records how far out it went, not just that it went", async () => {
    const { visitId } = await makeVisit();
    await dispatchSvc.onMyWay(ctxFor(["technician"]), {
      id: visitId, channel: "sms", etaMinutes: 35, includeTracking: false,
    });

    const [notice] = await raw`select eta_minutes, includes_tracking
      from public.arrival_notice where visit_id = ${visitId}`;
    expect(notice!.eta_minutes).toBe(35);
    expect(notice!.includes_tracking).toBe(false);
  });
});

run("every operation does something", () => {
  /**
   * The gap this closes was real and silent. Three kinds fell through to a
   * default branch whose comment claimed another path applied them. No such
   * path existed, the server marked them applied, and the phone deletes an
   * applied operation from its queue on the strength of that word. A chemical
   * application recorded in a crawl space was accepted, acknowledged and gone.
   *
   * So: every kind in the catalogue either changes something outside the log,
   * or is named in LOG_ONLY_OPERATIONS, and this proves the first by running
   * each one and watching a row appear.
   */
  /**
   * Every kind in the catalogue, run for real, with the rest of the schema
   * counted before and after. A kind that changes nothing outside the log is
   * a kind the server calls applied while discarding the work.
   *
   * Table driven rather than one test each, because the point is COVERAGE:
   * adding a kind without an effect has to fail here, and a per-kind test that
   * somebody forgets to write proves nothing.
   */
  const SIDE_EFFECT_TABLES = [
    "visit", "job_line", "equipment", "timeclock_entry",
    "service_report", "service_report_field", "field_upload", "portal_event",
  ] as const;

  async function fingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const table of SIDE_EFFECT_TABLES) {
      const rows = await raw.unsafe(
        `select count(*)::int as n, coalesce(max(updated_at)::text, '') as t
         from public.${table} where organization_id = $1`,
        [ORG],
      );
      parts.push(`${table}:${rows[0]!.n}:${rows[0]!.t}`);
    }
    return parts.join("|");
  }

  it("changes something outside the log, for every kind", async () => {
    const { visitId, jobId } = await makeVisit();
    const [report] = await raw`insert into public.service_report
      (organization_id, visit_id, job_id, customer_id, property_id)
      values (${ORG}, ${visitId}, ${jobId}, ${customerId}, ${propertyId}) returning id`;

    const cases: Array<{
      kind: (typeof field.OPERATION_KINDS)[number];
      subjectId?: string;
      payload: Record<string, unknown>;
    }> = [
      { kind: "visit.en_route", subjectId: visitId, payload: {} },
      { kind: "visit.arrive", subjectId: visitId, payload: {} },
      { kind: "visit.start", subjectId: visitId, payload: {} },
      { kind: "visit.pause", subjectId: visitId, payload: {} },
      { kind: "visit.note", subjectId: visitId, payload: { text: "A note" } },
      { kind: "timeclock.punch_in", payload: { technicianId, classification: "apprentice" } },
      { kind: "timeclock.punch_out", payload: { technicianId } },
      { kind: "service_report.set_field", subjectId: report!.id,
        payload: { field: "ambient_temp", value: 94, unit: "F" } },
      { kind: "visit.checklist_item", subjectId: visitId, payload: { itemId: "x", done: true } },
      { kind: "visit.add_line", subjectId: visitId,
        payload: { name: "Filter", quantity: "1", unitPrice: "24.00" } },
      { kind: "equipment.record",
        payload: { propertyId, category: "air_handler", serialNumber: `E-${uuid().slice(0, 8)}` } },
      { kind: "attachment.attach", subjectId: visitId,
        payload: { uploadId: uuid(), contentType: "image/jpeg" } },
      { kind: "signature.capture", subjectId: visitId,
        payload: { uploadId: uuid(), contentType: "image/png" } },
      { kind: "service_report.submit", subjectId: report!.id, payload: {} },
      { kind: "visit.complete", subjectId: visitId, payload: {} },
    ];

    // Every kind in the catalogue is exercised, or this test is not what it
    // says it is.
    const covered = new Set(cases.map((c) => c.kind));
    const missing = field.OPERATION_KINDS.filter((k) => !covered.has(k));
    expect(missing, `Not exercised: ${missing.join(", ")}`).toEqual([]);

    const device = await freshDevice();
    const inert: string[] = [];

    for (const [i, testCase] of cases.entries()) {
      const before = await fingerprint();

      const result = await fieldOps.sync(tech(), {
        deviceId: device,
        operations: [{
          clientId: uuid(),
          sequence: i + 1,
          kind: testCase.kind,
          ...(testCase.subjectId ? { subjectId: testCase.subjectId } : {}),
          occurredAt: new Date(Date.now() + i * 60_000).toISOString(),
          payload: testCase.payload,
        }],
      });

      const status = result.results[0]!.status;
      if (status !== "applied" && status !== "conflicted") continue;

      if ((await fingerprint()) === before) inert.push(testCase.kind);
    }

    const logOnly = new Set<string>(fieldOps.LOG_ONLY_OPERATIONS);
    const silent = inert.filter((k) => !logOnly.has(k));

    expect(
      silent,
      `These kinds were marked applied and changed nothing. The phone deletes ` +
      `an applied operation from its queue, so this is work being discarded: ` +
      `${silent.join(", ")}`,
    ).toEqual([]);
  });

  it("writes a reading when a technician fills in a form field", async () => {
    const { visitId, jobId } = await makeVisit();
    const [report] = await raw`insert into public.service_report
      (organization_id, visit_id, job_id, customer_id, property_id)
      values (${ORG}, ${visitId}, ${jobId}, ${customerId}, ${propertyId}) returning id`;

    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "service_report.set_field",
        subjectId: report!.id, occurredAt: new Date().toISOString(),
        payload: { field: "suction_pressure", label: "Suction pressure", value: 118, unit: "psi" },
      }],
    });

    const [row] = await raw`select key, value_numeric, unit from public.service_report_field
      where report_id = ${report!.id}`;
    expect(row!.key).toBe("suction_pressure");
    expect(Number(row!.value_numeric)).toBe(118);
    expect(row!.unit).toBe("psi");
  });

  it("keeps the regulated columns a chemical application needs", async () => {
    const { visitId, jobId } = await makeVisit();
    const [report] = await raw`insert into public.service_report
      (organization_id, visit_id, job_id, customer_id, property_id)
      values (${ORG}, ${visitId}, ${jobId}, ${customerId}, ${propertyId}) returning id`;

    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "service_report.set_field",
        subjectId: report!.id, occurredAt: new Date().toISOString(),
        payload: {
          field: "perimeter_treatment", kind: "chemical", value: "Applied",
          productName: "Termidor SC", epaRegistrationNumber: "432-1278",
          quantityApplied: "1.5", applicationUnit: "gal",
          applicatorLicense: "TX-PMT-44812", targetPest: "Subterranean termite",
        },
      }],
    });

    // Reconstructing any of this later is the exercise these columns exist to
    // avoid, and it has a real number attached.
    const [row] = await raw`select product_name, epa_registration_number,
      applicator_license, target_pest from public.service_report_field
      where report_id = ${report!.id}`;
    expect(row!.product_name).toBe("Termidor SC");
    expect(row!.epa_registration_number).toBe("432-1278");
    expect(row!.applicator_license).toBe("TX-PMT-44812");
    expect(row!.target_pest).toBe("Subterranean termite");
  });

  it("records a part used as a job line, not an invoice line", async () => {
    const { visitId, jobId } = await makeVisit();

    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.add_line",
        subjectId: visitId, occurredAt: new Date().toISOString(),
        payload: {
          kind: "part", name: "Dual run capacitor 45/5",
          quantity: "1", unitPrice: "189.00", unitCost: "22.40",
        },
      }],
    });

    const [line] = await raw`select name, unit_price, unit_cost, source, invoice_line_id
      from public.job_line where job_id = ${jobId}`;
    expect(line!.name).toBe("Dual run capacitor 45/5");
    expect(Number(line!.unit_cost)).toBe(22.4);
    expect(line!.source).toBe("field");
    // Unbilled until something bills it, which is how unbilled work becomes a
    // query rather than a discovery at the end of the month.
    expect(line!.invoice_line_id).toBeNull();
  });

  it("attributes a field line to the technician whose phone it came from", async () => {
    const { visitId, jobId } = await makeVisit();
    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.add_line",
        subjectId: visitId, occurredAt: new Date().toISOString(),
        payload: { name: "Two hours labour", kind: "labor", quantity: "2", unitPrice: "150.00" },
      }],
    });

    const [line] = await raw`select technician_id from public.job_line where job_id = ${jobId}`;
    expect(line!.technician_id).toBe(technicianId);
  });

  it("keeps a warranty line with a cost and no price", async () => {
    // A zero dollar line under a warranty and a zero dollar line that is our
    // own callback look identical on a revenue report and mean opposite
    // things. The cost is what tells them apart.
    const { visitId, jobId } = await makeVisit();
    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "visit.add_line",
        subjectId: visitId, occurredAt: new Date().toISOString(),
        payload: {
          name: "Compressor, under warranty", quantity: "1",
          unitPrice: "0", unitCost: "870.00", nonBillableReason: "manufacturer_warranty",
        },
      }],
    });

    const [line] = await raw`select unit_price, unit_cost, non_billable_reason
      from public.job_line where job_id = ${jobId}`;
    expect(Number(line!.unit_price)).toBe(0);
    expect(Number(line!.unit_cost)).toBe(870);
    expect(line!.non_billable_reason).toBe("manufacturer_warranty");
  });

  it("records equipment a technician found on site", async () => {
    // Scoped to this unit's serial. A property accumulates equipment across
    // tests as it does across ten years, and selecting by property alone
    // returns whichever furnace happened to be inserted first.
    const serial = `4218E-${uuid().slice(0, 8)}`;

    await fieldOps.sync(tech(), {
      deviceId: await freshDevice(),
      operations: [{
        clientId: uuid(), sequence: 1, kind: "equipment.record",
        occurredAt: new Date().toISOString(),
        payload: {
          propertyId, category: "condenser", manufacturer: "Carrier",
          model: "24ACC636A003", serialNumber: serial, location: "South side",
        },
      }],
    });

    const [row] = await raw`select manufacturer, model, serial_number
      from public.equipment where property_id = ${propertyId} and serial_number = ${serial}`;
    expect(row!.manufacturer).toBe("Carrier");
    expect(row!.model).toBe("24ACC636A003");
  });

  it("updates the same unit rather than creating a second one", async () => {
    /**
     * Matched on serial number, because that is the only identifier that
     * survives the customer moving out and the next owner calling. Matching on
     * anything softer splits ten years of history down the middle.
     */
    const device = await freshDevice();
    const serial = `SN-${uuid().slice(0, 8)}`;

    for (const [i, location] of ["Attic", "Attic, north end"].entries()) {
      await fieldOps.sync(tech(), {
        deviceId: device,
        operations: [{
          clientId: uuid(), sequence: i + 1, kind: "equipment.record",
          occurredAt: new Date().toISOString(),
          payload: { propertyId, category: "furnace", serialNumber: serial, location },
        }],
      });
    }

    const rows = await raw`select location from public.equipment
      where property_id = ${propertyId} and serial_number = ${serial}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.location).toBe("Attic, north end");
  });
});

/** A fixed morning, so a failure message names a readable time. */
const reportAt = (hour: number, minute: number) =>
  new Date(Date.UTC(2026, 0, 12, hour, minute)).toISOString();

run("a service report that reaches the database", () => {
  /**
   * NOTHING EVER CREATED A SERVICE REPORT ROW. `service_report` was the
   * target of exactly one write, an update setting `submitted_at`, and no
   * insert anywhere outside a test file. So a technician filled in a report
   * on their phone, the sync accepted every operation and reported success,
   * `submit` updated zero rows, and `set_field` looked the report up, found
   * nothing, and returned. Every reading, every refrigerant weight and every
   * chemical application went on the floor one operation at a time, silently,
   * with a tick on the phone.
   *
   * `effect` returned void, which is why nobody could have noticed.
   */
  const reportRow = (id: string) => raw<{
    visit_id: string; job_id: string; customer_id: string;
    property_id: string; submitted_at: Date | null;
  }[]>`select visit_id, job_id, customer_id, property_id, submitted_at
       from public.service_report where id = ${id}`;

  it("creates the report from the visit the operation names", async () => {
    const { visitId } = await makeVisit();
    const device = await freshDevice();
    const reportId = uuid();

    const { results } = await fieldOps.sync(tech(), {
      deviceId: device,
      operations: [{
        clientId: uuid(), sequence: 1, kind: "service_report.set_field",
        occurredAt: reportAt(9, 0), subjectId: reportId,
        payload: { visitId, field: "superheat", value: "12" },
      }],
    });

    expect(results[0]!.status).toBe("applied");

    const [row] = await reportRow(reportId);
    expect(row!.visit_id).toBe(visitId);
    // And the field landed, which is the whole point.
    const fields = await raw`select key from public.service_report_field
      where report_id = ${reportId}`;
    expect(fields).toHaveLength(1);
  });

  it("rejects an operation it cannot file, instead of reporting success", async () => {
    /**
     * The failure this whole change is about. A report with no visit cannot
     * be attached to a job, a customer or a property, so there is nowhere to
     * read it back from. Accepting it would be the same silent loss under a
     * new name.
     */
    const device = await freshDevice();

    const { results } = await fieldOps.sync(tech(), {
      deviceId: device,
      operations: [{
        clientId: uuid(), sequence: 1, kind: "service_report.set_field",
        occurredAt: reportAt(9, 0), subjectId: uuid(),
        payload: { field: "superheat", value: "12" },
      }],
    });

    expect(results[0]!.status).toBe("rejected");
    expect(results[0]!.rejection).toMatch(/not attached to a visit/i);
  });

  it("records the rejection in the log, not just in the reply", async () => {
    // The phone may never come back. The office has to be able to see that
    // something was thrown away and why.
    const device = await freshDevice();
    const clientId = uuid();

    await fieldOps.sync(tech(), {
      deviceId: device,
      operations: [{
        clientId, sequence: 1, kind: "service_report.submit",
        occurredAt: reportAt(9, 0), subjectId: uuid(), payload: {},
      }],
    });

    const [row] = await raw<{ status: string; rejection: string | null }[]>`
      select status, rejection from public.field_operation where client_id = ${clientId}`;
    expect(row!.status).toBe("rejected");
    expect(row!.rejection).toBeTruthy();
  });

  it("submits a report the same operation stream created", async () => {
    const { visitId } = await makeVisit();
    const device = await freshDevice();
    const reportId = uuid();

    const { results } = await fieldOps.sync(tech(), {
      deviceId: device,
      operations: [
        {
          clientId: uuid(), sequence: 1, kind: "service_report.set_field",
          occurredAt: reportAt(9, 0), subjectId: reportId,
          payload: { visitId, field: "subcooling", value: "9" },
        },
        {
          clientId: uuid(), sequence: 2, kind: "service_report.submit",
          occurredAt: reportAt(9, 30), subjectId: reportId,
          payload: { visitId },
        },
      ],
    });

    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect((await reportRow(reportId))[0]!.submitted_at).not.toBeNull();
  });

  it("does not create a second report when the phone resends", async () => {
    const { visitId } = await makeVisit();
    const reportId = uuid();

    for (const sequence of [1, 2]) {
      const device = await freshDevice();
      await fieldOps.sync(tech(), {
        deviceId: device,
        operations: [{
          clientId: uuid(), sequence: 1, kind: "service_report.set_field",
          occurredAt: reportAt(9, sequence), subjectId: reportId,
          payload: { visitId, field: "superheat", value: String(sequence) },
        }],
      });
    }

    const rows = await raw`select id from public.service_report where id = ${reportId}`;
    expect(rows).toHaveLength(1);
  });
});
