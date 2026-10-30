import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as portal from "../src/services/portal";
import * as visitChanges from "../src/services/visit-changes";
import * as booking from "../src/services/booking";
import { PermissionError } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE TIMES OFFERED, FROM THE OFFICE QUEUE (M05)
 *
 * After a customer says no to the time offered, the queue offers the next free
 * times with one press each and never offers by itself; an offer waiting for the
 * customer, and a time taken back, are in the queue too, so they can be taken
 * back and offered again from there and not only from the job's page.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("vcq:org");
const USER = fixtureId("vcq:user");
const PHONE = "+15125550177";
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const office = () => as(["dispatcher"]);

let customerId = "";
let propertyId = "";
let jobTypeId = "";
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Offers Queue Plumbing", slug: "visit-offers-queue-plumbing" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559933', 'main', true)`;

  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Dana Change', ${PHONE}) returning id`;
  customerId = c!.id;
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
  await raw`insert into public.bookable_service
    (organization_id, job_type_id, public_name, min_notice_hours, max_advance_days, max_per_window)
    values (${ORG}, ${jobTypeId}, 'Drain cleaning', 24, 60, 2)`;
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



/** A request to move, answered with a time the customer then answers. */
async function offered() {
  const coming = await aComingVisit();
  const asked = await visitChanges.request(db(), {
    token: coming.token, kind: "reschedule", requestedDate: dayFromNow(9), arrivalWindowId: windowId,
  });
  await visitChanges.propose(office(), { id: asked.id, date: dayFromNow(11), arrivalWindowId: windowId });
  return { ...coming, asked };
}
const openTasks = () => raw<{ id: string; title: string; entity_type: string | null; entity_id: string | null }[]>`
  select id, title, entity_type, entity_id from public.task where organization_id = ${ORG} and status = 'open'`;

run("the next free times after a no", () => {
  it("lists the next free windows soonest first, without the one turned down, and offers nothing by itself", async () => {
    const { token, visitId, asked } = await offered();
    await raw`delete from public.message where organization_id = ${ORG}`;
    await visitChanges.answer(db(), { token, visitId, accept: false, answer: "Not Fridays" });

    // A no raises the task to talk to them and nothing else: no new offer, no message.
    const [task] = await openTasks();
    expect(task).toMatchObject({ entity_type: "visit", entity_id: visitId });
    expect(task!.title).toMatch(/said no to/);
    expect(await outbound()).toEqual([]);
    expect((await raw`select status from public.visit_change_request where id = ${asked.id}`)[0]!.status).toBe("turned_down");

    const next = await visitChanges.nextTimes(office(), { id: asked.id });
    expect(next).toHaveLength(3);
    expect(next.map((s) => `${s.date}|${s.arrivalWindowId}`)).toEqual([...next].map((s) => `${s.date}|${s.arrivalWindowId}`).sort());
    // The time they turned down (day 11) is not offered again; the soonest others are.
    expect(next.map((s) => s.date)).not.toContain(dayFromNow(11));
    const all = await visitChanges.proposalTimes(office(), { id: asked.id });
    expect(all.map((s) => s.date)).toContain(dayFromNow(11));
    expect(next[0]!.date).toBe(all.filter((s) => s.date !== dayFromNow(11))[0]!.date);
    expect(await visitChanges.nextTimes(office(), { id: asked.id, count: 1 })).toHaveLength(1);
    // Looking changed nothing and told nobody.
    expect(await outbound()).toEqual([]);
    expect((await raw`select status from public.visit_change_request where id = ${asked.id}`)[0]!.status).toBe("turned_down");
  });

  it("is one press to offer: the time is sent with the link, and the no task is closed", async () => {
    const { token, visitId, asked } = await offered();
    await visitChanges.answer(db(), { token, visitId, accept: false });
    const [first] = await visitChanges.nextTimes(office(), { id: asked.id });
    await raw`delete from public.message where organization_id = ${ORG}`;
    const sent = await visitChanges.propose(office(), { id: asked.id, date: first!.date, arrivalWindowId: first!.arrivalWindowId });
    expect(sent).toMatchObject({ status: "proposed", proposedDate: first!.date, notified: "queued" });
    expect((await outbound())[0]!.body).toContain("Could we come");
    expect(await openTasks()).toHaveLength(0);
  });

  it("lists nothing for a cancellation, and without the right to read visits", async () => {
    const coming = await aComingVisit();
    const asked = await visitChanges.request(db(), { token: coming.token, kind: "cancel", reason: "Changed my mind" });
    expect(await visitChanges.nextTimes(office(), { id: asked.id })).toEqual([]);
    const nobody: ServiceContext = { actor: { userId: USER, organizationId: ORG, roles: [], grants: [] } as Actor, db: db() };
    await expect(visitChanges.nextTimes(nobody, { id: asked.id })).rejects.toThrow(PermissionError);
  });
});

run("the offers still held, for the queue", () => {
  it("lists a time waiting for the customer, and a time taken back, and takes the first back from there", async () => {
    const waiting = await offered();
    const second = await offered();
    await visitChanges.withdraw(office(), { id: second.asked.id });

    const held = await visitChanges.openOffers(office());
    expect(held.map((o) => [o.id, o.status]).sort()).toEqual([
      [waiting.asked.id, "proposed"], [second.asked.id, "withdrawn"],
    ].sort());

    await raw`delete from public.message where organization_id = ${ORG}`;
    const back = await visitChanges.withdraw(office(), { id: waiting.asked.id, response: "Off that day." });
    expect(back.status).toBe("withdrawn");
    expect((await outbound())[0]!.body).toContain("We have taken back the time we offered");
    expect((await visitChanges.openOffers(office())).every((o) => o.status === "withdrawn")).toBe(true);
    // The visit never moved.
    expect((await visitRow(waiting.visitId)).window_start.toISOString()).toBe(at(waiting.day, "13:00").toISOString());
  });

  it("offers a taken back time again from there, and it leaves the list", async () => {
    const { asked } = await offered();
    await visitChanges.withdraw(office(), { id: asked.id });
    const [first] = await visitChanges.nextTimes(office(), { id: asked.id });
    await visitChanges.propose(office(), { id: asked.id, date: first!.date, arrivalWindowId: first!.arrivalWindowId });
    expect((await visitChanges.openOffers(office())).map((o) => [o.id, o.status])).toEqual([[asked.id, "proposed"]]);
  });

  it("brings in a time taken back only for two weeks, and leaves out one the customer has asked again about", async () => {
    const { asked, token, visitId } = await offered();
    await visitChanges.withdraw(office(), { id: asked.id });
    await raw`update public.visit_change_request set updated_at = now() - interval '15 days' where id = ${asked.id}`;
    expect(await visitChanges.openOffers(office())).toEqual([]);
    await raw`update public.visit_change_request set updated_at = now() where id = ${asked.id}`;
    expect(await visitChanges.openOffers(office())).toHaveLength(1);
    await visitChanges.request(db(), { token, visitId, kind: "cancel", reason: "Never mind" });
    expect(await visitChanges.openOffers(office())).toEqual([]);
  });

  it("brings in a no only for the tasks the queue names, and not once the visit is done", async () => {
    const { token, visitId, asked } = await offered();
    await visitChanges.answer(db(), { token, visitId, accept: false });
    const [task] = await openTasks();
    expect(await visitChanges.openOffers(office())).toEqual([]);
    expect((await visitChanges.openOffers(office(), { taskIds: [task!.id] })).map((o) => o.id)).toEqual([asked.id]);
    await raw`update public.visit set status = 'completed' where id = ${visitId}`;
    expect(await visitChanges.openOffers(office(), { taskIds: [task!.id] })).toEqual([]);
  });

  it("is for those who can answer a request: reading visits is not enough to offer", async () => {
    const { asked } = await offered();
    await expect(visitChanges.propose(as(["technician"]), { id: asked.id, date: dayFromNow(12), arrivalWindowId: windowId }))
      .rejects.toThrow(PermissionError);
    await expect(visitChanges.withdraw(as(["technician"]), { id: asked.id })).rejects.toThrow(PermissionError);
  });
});
