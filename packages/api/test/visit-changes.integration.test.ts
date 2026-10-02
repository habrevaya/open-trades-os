import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { time, type Actor } from "@opentradesos/core";
import * as portal from "../src/services/portal";
import * as visitChanges from "../src/services/visit-changes";
import * as booking from "../src/services/booking";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * MOVING OR CANCELLING A VISIT FROM THE CUSTOMER'S LINK
 *
 * A request and never a move: the customer asks from their link, choosing from
 * the windows online booking would offer, and the office approves or declines
 * from the job or the queue. These tests hold the three things that make it
 * safe to put in front of a customer: nothing moves until a person says so,
 * the company's booking rules decide what can be asked for, and the customer
 * is told the answer.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("vcr:org");
const USER = fixtureId("vcr:user");
const PHONE = "+15125550166";
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const office = () => as(["dispatcher"]);

let customerId = "";
let otherCustomerId = "";
let propertyId = "";
let jobTypeId = "";
let serviceId = "";
let windowId = "";
let technicianId = "";

/** A calendar day in Austin, some days from today. */
const dayFromNow = (days: number) => {
  const d = new Date(`${time.dateIn(new Date(), ZONE)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const at = (date: string, clock: string) => booking.windowStart(date, clock, ZONE);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Visit Change Plumbing", slug: "visit-change-plumbing" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559922', 'main', true)`;

  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Dana Change', ${PHONE}) returning id`;
  customerId = c!.id;
  const [o] = await raw`insert into public.customer (organization_id, name)
    values (${ORG}, 'Somebody Else') returning id`;
  otherCustomerId = o!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '3 Change Ct', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;

  const [t] = await raw`insert into public.job_type (organization_id, name) values (${ORG}, 'Drain cleaning') returning id`;
  jobTypeId = t!.id;
  const [membership] = await raw`select id from public.membership where organization_id = ${ORG} limit 1`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Theo Tech') returning id`;
  technicianId = tech!.id;

  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  const [w] = await raw`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
  windowId = w!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.visit_change_request where organization_id = ${ORG}`;
  await raw`delete from public.booking_request where organization_id = ${ORG}`;
  await raw`delete from public.bookable_service where organization_id = ${ORG}`;
  await raw`delete from public.territory where organization_id = ${ORG}`;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.portal_event where organization_id = ${ORG}`;
  await raw`delete from public.portal_grant where organization_id = ${ORG}`;
  await raw`delete from public.visit_assignment where organization_id = ${ORG}`;
  await raw`delete from public.visit where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  const [s] = await raw`insert into public.bookable_service
    (organization_id, job_type_id, public_name, min_notice_hours, max_advance_days, max_per_window)
    values (${ORG}, ${jobTypeId}, 'Drain cleaning', 24, 60, 2) returning id`;
  serviceId = s!.id;
});

/** A dispatched visit five days out, with a technician on it, and the customer's link to the job. */
async function aComingVisit(over: { customer?: string; jobType?: string | null } = {}) {
  const day = dayFromNow(5);
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${over.customer ?? customerId}, ${propertyId},
            ${over.jobType === undefined ? jobTypeId : over.jobType}, 'scheduled', 'Kitchen drain') returning id`;
  const [visit] = await raw`insert into public.visit
    (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'dispatched', ${at(day, "13:00")}, ${at(day, "17:00")}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
            values (${ORG}, ${visit!.id}, ${technicianId}, true)`;
  const link = await inTenant(as(["owner"]), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId: over.customer ?? customerId, scope: "job", subjectId: job!.id, expiresInDays: 30,
  }));
  return { jobId: job!.id as string, visitId: visit!.id as string, token: link.token, day };
}

const visitRow = async (id: string) => {
  const [row] = await raw<{ status: string; window_start: Date; window_end: Date }[]>`
    select status, window_start, window_end from public.visit where id = ${id}`;
  return row!;
};
const outbound = () => raw<{ body: string; to_address: string }[]>`
  select body, to_address from public.message where organization_id = ${ORG} and direction = 'outbound'`;

run("what the customer is offered", () => {
  it("offers the windows online booking would, inside the notice period and the calendar", async () => {
    const { token } = await aComingVisit();
    const options = await visitChanges.options(db(), { token });
    expect(options.canChange).toBe(true);
    expect(options.rescheduleBlockedBy).toBeNull();
    // Tomorrow morning is inside the 24 hour notice; the day after is not.
    const dates = options.slots.map((s) => s.date);
    expect(dates).not.toContain(dayFromNow(0));
    expect(dates).toContain(dayFromNow(2));
    expect(options.slots.every((s) => s.arrivalWindowId === windowId)).toBe(true);

    /** The same function the public widget answers from, so the two cannot disagree. */
    const [service] = await inTenant(as(["owner"]), (tx) =>
      tx.select().from(schema.bookableService).where(eq(schema.bookableService.id, serviceId)));
    const publicSlots = await booking.openSlots(db(), {
      organizationId: ORG, timezone: ZONE, service: service!, from: dayFromNow(0), days: 21,
    });
    expect(publicSlots.map((s) => s.date)).toEqual(options.slots.map((s) => s.date));
  });

  it("offers nothing to move to when the notice period covers every day it would offer", async () => {
    await raw`update public.bookable_service set min_notice_hours = ${24 * 40} where id = ${serviceId}`;
    const { token } = await aComingVisit();
    const options = await visitChanges.options(db(), { token, days: 21 });
    expect(options.slots).toEqual([]);
    expect(options.rescheduleBlockedBy).toMatch(/no open times/);
    // Cancelling is still theirs to ask for.
    expect(options.canChange).toBe(true);
  });

  it("keeps an address outside the area the work is booked online for to the office", async () => {
    const [territory] = await raw`insert into public.territory (organization_id, name, postal_codes)
      values (${ORG}, 'North', ${raw.json(["78750"])}) returning id`;
    await raw`update public.bookable_service set territory_id = ${territory!.id} where id = ${serviceId}`;
    const { token, day } = await aComingVisit();
    expect((await visitChanges.options(db(), { token })).rescheduleBlockedBy).toMatch(/outside the area/);
    await expect(visitChanges.request(db(), {
      token, kind: "reschedule", requestedDate: dayFromNow(9), arrivalWindowId: windowId,
    })).rejects.toThrow(/outside the area/);
    expect(day).toBeTruthy();
  });

  it("offers no move for work the company does not take online, and says what to do instead", async () => {
    const { token } = await aComingVisit({ jobType: null });
    expect((await visitChanges.options(db(), { token })).rescheduleBlockedBy).toMatch(/cannot be moved online/);
  });

  it("does not reach another customer's visit from this customer's link", async () => {
    const mine = await aComingVisit();
    const theirs = await aComingVisit({ customer: otherCustomerId });
    await expect(visitChanges.options(db(), { token: mine.token, visitId: theirs.visitId }))
      .rejects.toThrow(NotFoundError);
  });
});

run("asking", () => {
  it("writes a request and a task, and moves nothing", async () => {
    const { token, visitId, day } = await aComingVisit();
    const target = dayFromNow(9);
    const asked = await visitChanges.request(db(), {
      token, kind: "reschedule", requestedDate: target, arrivalWindowId: windowId, reason: "Away that week",
    });
    expect(asked.status).toBe("pending");
    expect(asked.requestedStart).toBe(at(target, "08:00").toISOString());

    // Nothing moved.
    const visit = await visitRow(visitId);
    expect(visit.status).toBe("dispatched");
    expect(visit.window_start.toISOString()).toBe(at(day, "13:00").toISOString());

    const tasks = await raw<{ title: string; entity_type: string; priority: string; body: string }[]>`
      select title, entity_type, priority, body from public.task where organization_id = ${ORG}`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.entity_type).toBe("visit_change_request");
    expect(tasks[0]!.priority).toBe("high");
    expect(tasks[0]!.title).toContain("Dana Change asks to move their visit");
    expect(tasks[0]!.body).toContain("Away that week");

    const [event] = await raw`select name from public.domain_event where organization_id = ${ORG} and name = 'visit.change_requested'`;
    expect(event).toBeTruthy();
  });

  it("treats the same request twice as one, and refuses a different one while it waits", async () => {
    const { token } = await aComingVisit();
    const input = { token, kind: "reschedule" as const, requestedDate: dayFromNow(9), arrivalWindowId: windowId };
    const first = await visitChanges.request(db(), input);
    expect((await visitChanges.request(db(), input)).id).toBe(first.id);
    await expect(visitChanges.request(db(), { token, kind: "cancel", reason: "Changed my mind" }))
      .rejects.toThrow(/already asked about this visit/);
    expect((await visitChanges.options(db(), { token })).pending?.id).toBe(first.id);
  });

  it("refuses a window inside the notice period, and a cancellation with no reason", async () => {
    const { token } = await aComingVisit();
    await expect(visitChanges.request(db(), {
      token, kind: "reschedule", requestedDate: dayFromNow(0), arrivalWindowId: windowId,
    })).rejects.toThrow(/not open any more/);
    await expect(visitChanges.request(db(), { token, kind: "cancel" })).rejects.toThrow(/Tell us why/);
  });

  it("will not take a request for a visit already on its way", async () => {
    const { token, visitId } = await aComingVisit();
    await raw`update public.visit set status = 'en_route' where id = ${visitId}`;
    await expect(visitChanges.request(db(), { token, kind: "cancel", reason: "Too late" }))
      .rejects.toThrow(ConflictError);
  });
});

run("the office answering", () => {
  it("moves the visit on approval, takes it off the technician's day, closes the task and tells the customer", async () => {
    const { token, visitId } = await aComingVisit();
    const target = dayFromNow(9);
    const asked = await visitChanges.request(db(), {
      token, kind: "reschedule", requestedDate: target, arrivalWindowId: windowId,
    });

    const approved = await visitChanges.approve(office(), { id: asked.id });
    expect(approved).toMatchObject({ status: "approved", notified: "queued", assignmentsRemoved: 1 });

    const visit = await visitRow(visitId);
    expect(visit.window_start.toISOString()).toBe(at(target, "08:00").toISOString());
    expect(visit.window_end.toISOString()).toBe(at(target, "12:00").toISOString());
    expect(visit.status).toBe("unassigned");
    expect(await raw`select id from public.visit_assignment where visit_id = ${visitId}`).toHaveLength(0);

    const [task] = await raw<{ status: string }[]>`select status from public.task where organization_id = ${ORG}`;
    expect(task!.status).toBe("done");

    const [message] = await outbound();
    expect(message!.to_address).toBe(PHONE);
    expect(message!.body).toContain("has been moved to");

    // Answering twice is the same answer.
    expect((await visitChanges.approve(office(), { id: asked.id })).status).toBe("approved");
  });

  it("cancels the visit when that is what was asked, with the customer's reason kept", async () => {
    const { token, visitId } = await aComingVisit();
    const asked = await visitChanges.request(db(), { token, kind: "cancel", reason: "Fixed it myself" });
    await visitChanges.approve(office(), { id: asked.id });
    expect((await visitRow(visitId)).status).toBe("cancelled");
    expect((await outbound())[0]!.body).toContain("has been cancelled");
    const [listed] = await visitChanges.list(office(), { status: "approved" });
    expect(listed!.reason).toBe("Fixed it myself");
  });

  it("leaves the visit where it was on a decline and sends the office's words", async () => {
    const { token, visitId, day } = await aComingVisit();
    const asked = await visitChanges.request(db(), {
      token, kind: "reschedule", requestedDate: dayFromNow(9), arrivalWindowId: windowId,
    });
    const declined = await visitChanges.decline(office(), { id: asked.id, response: "We are full that week. Could Monday work?" });
    expect(declined).toMatchObject({ status: "declined", notified: "queued" });
    expect((await visitRow(visitId)).window_start.toISOString()).toBe(at(day, "13:00").toISOString());
    expect((await outbound())[0]!.body).toContain("Could Monday work?");
    expect((await visitChanges.options(db(), { token })).decided).toMatchObject({ status: "declined" });
  });

  it("will not approve a move into a window that filled up after the customer asked", async () => {
    await raw`update public.bookable_service set max_per_window = 1 where id = ${serviceId}`;
    const { token } = await aComingVisit();
    const target = dayFromNow(9);
    const asked = await visitChanges.request(db(), {
      token, kind: "reschedule", requestedDate: target, arrivalWindowId: windowId,
    });
    await raw`insert into public.booking_request
      (organization_id, bookable_service_id, status, contact_name, requested_date, arrival_window_id)
      values (${ORG}, ${serviceId}, 'confirmed', 'A new customer', ${target}, ${windowId})`;
    await expect(visitChanges.approve(office(), { id: asked.id })).rejects.toThrow(/filled up/);
  });

  it("is the dispatch permission's to decide, not anybody's who can read the board", async () => {
    const { token } = await aComingVisit();
    const asked = await visitChanges.request(db(), { token, kind: "cancel", reason: "Moving house" });
    await expect(visitChanges.approve(as(["technician"]), { id: asked.id })).rejects.toThrow();
    expect((await visitChanges.list(office(), { status: "pending" })).map((r) => r.id)).toEqual([asked.id]);
  });
});
