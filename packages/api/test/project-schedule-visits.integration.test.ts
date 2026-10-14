import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import * as changeOrders from "../src/services/project-change-orders";
import * as scheduling from "../src/services/project-schedule";
import { windowStart } from "../src/services/booking";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M12. A CHANGE ORDER'S DAYS MOVE THE VISITS ALREADY BOOKED ON THE PHASES THEY MOVE.
 *
 * Rough in, then fixtures, then paint. Three more days on rough in move
 * fixtures and paint three days later, and their visits with them: each at
 * the same time of day three days on, listed with its old and new time
 * before anything moves. A visit whose person is off at the new time, or
 * booked on another visit then, stays where it is and is named with why.
 * Applied, the visits move, the customer is told through the visit change
 * notice, and the change order keeps what it moved and what it left.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m12visits:org");
const USER = fixtureId("m12visits:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);
const day = (n: number) => companyToday(n);
const at = (n: number, clock = "09:00") => windowStart(day(n), clock, ZONE);

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fitout Visits Co", slug: "fitout-visits-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, email)
    values (${ORG}, 'commercial', 'Hillcrest Partners', 'owner@hillcrest.test') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '14 Hillcrest', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
});

async function tech(name: string) {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

async function visit(phaseId: string, technicianId: string, start: Date, status = "scheduled") {
  const [link] = await raw<{ job_id: string }[]>`select job_id from public.project_job where project_phase_id = ${phaseId}`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${link!.job_id}, ${status}::visit_status, ${start}, ${new Date(start.getTime() + 3 * 3_600_000)}, 180) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${technicianId})`;
  return v!.id;
}

/** A visit for somebody else entirely, holding a person's time. */
async function elsewhere(technicianId: string, start: Date) {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'Service call') returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, 'scheduled', ${start}, ${new Date(start.getTime() + 2 * 3_600_000)}, 120) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${technicianId})`;
}

const startOf = async (visitId: string) =>
  (await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${visitId}`)[0]!.window_start;

/** Rough in, then fixtures, then paint, with a job on each and a change order of three more days on rough in. */
async function fitout() {
  const project = await projects.create(owner(), { customerId, propertyId, name: "Hillcrest fit out", contractValue: "100000" });
  const rough = await projects.addPhase(owner(), {
    projectId: project.id, name: "Rough in", billingValue: "50000", startsOn: day(10), endsOn: day(14),
  });
  const fixtures = await projects.addPhase(owner(), {
    projectId: project.id, name: "Fixtures", billingValue: "30000", dependsOnPhaseId: rough.id, startsOn: day(17), endsOn: day(19),
  });
  const paint = await projects.addPhase(owner(), {
    projectId: project.id, name: "Paint", billingValue: "20000", dependsOnPhaseId: fixtures.id, startsOn: day(20), endsOn: day(21),
  });
  await projects.materialise(owner(), { id: project.id });
  const order = await changeOrders.request(owner(), { projectId: project.id, title: "Two more circuits", phaseId: rough.id, scheduleDays: 3 });
  await changeOrders.addLine(owner(), { changeOrderId: order.id, name: "Two more circuits", quantity: "1", unitPrice: "900" });
  await changeOrders.decide(owner(), { id: order.id, decision: "approved", signerName: "Pat Owner" });
  return { project, rough, fixtures, paint, order: order.id };
}

run("the visits on the phases a change order moves", () => {
  it("are listed with their old and new times, and the ones that cannot go stay, named", async () => {
    const { rough, fixtures, paint, order } = await fitout();
    const ray = await tech("Ray Nunez");
    const sam = await tech("Sam Ortiz");
    const nia = await tech("Nia Osei");
    const onRough = await visit(rough.id, ray, at(12));
    const moving = await visit(fixtures.id, ray, at(17));
    const samOff = await visit(fixtures.id, sam, at(18));
    const niaBusy = await visit(paint.id, nia, at(20));
    await visit(fixtures.id, ray, at(18, "14:00"), "completed");
    await raw`insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
      values (${ORG}, ${sam}, ${windowStart(day(21), "00:00", ZONE)}, ${windowStart(day(22), "00:00", ZONE)}, true)`;
    await elsewhere(nia, at(23, "10:00"));

    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(seen.canApply).toBe(true);
    const { moves, left } = seen.proposal!.visits;
    expect(moves.map((m) => [m.id, m.wasStart.toISOString(), m.start.toISOString(), m.people])).toEqual([
      [moving, at(17).toISOString(), at(20).toISOString(), ["Ray Nunez"]],
    ]);
    expect(moves[0]!.label).toMatch(/^Hillcrest Partners, job \d+$/);
    expect(left.map((l) => [l.id, l.reason])).toEqual([
      [samOff, "Sam Ortiz is off at the new time, so it stays where it is."],
      [niaBusy, "Nia Osei is booked on another visit at the new time, so it stays where it is."],
    ]);
    /** Looking moved nothing. */
    expect((await startOf(moving)).toISOString()).toBe(at(17).toISOString());

    /** A customer service seat may move the phases, but not booked visits. */
    await expect(scheduling.applyChangeOrderDays(as(["csr"]), { id: order, proposalKey: seen.proposal!.key }))
      .rejects.toBeInstanceOf(PermissionError);

    const done = await scheduling.applyChangeOrderDays(as(["dispatcher"]), { id: order, proposalKey: seen.proposal!.key });
    expect(done.alreadyApplied).toBe(false);
    expect((await startOf(moving)).toISOString()).toBe(at(20).toISOString());
    expect((await startOf(onRough)).toISOString()).toBe(at(12).toISOString());
    expect((await startOf(samOff)).toISOString()).toBe(at(18).toISOString());
    expect((await startOf(niaBusy)).toISOString()).toBe(at(20).toISOString());
    expect(done.applied!.visits.moved.map((v) => [v.id, v.start])).toEqual([[moving, at(20).toISOString()]]);
    expect(done.applied!.visits.left.map((v) => v.id)).toEqual([samOff, niaBusy]);

    /** The customer is told through the visit change notice, saying the change order moved it. */
    const [told] = await raw<{ after: { notified: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'visit.moved_by_office' and entity_id = ${moving}`;
    expect(told).toBeDefined();
    /** This company has no email sender registered, so the notice says it was not emailed, rather than claiming it went. */
    expect(told!.after.notified).toMatch(/^(queued|Not emailed: )/);
    expect(done.applied!.visits.moved[0]!.notified).toBe(told!.after.notified);
    const [event] = await raw<{ kind: string }[]>`
      select kind::text from public.portal_event where organization_id = ${ORG} and customer_id = ${customerId} and kind = 'rescheduled'`;
    expect(event?.kind).toBe("rescheduled");

    /** Once. A retry moves nothing further. */
    const again = await scheduling.applyChangeOrderDays(as(["dispatcher"]), { id: order, proposalKey: seen.proposal!.key });
    expect(again.alreadyApplied).toBe(true);
    expect((await startOf(moving)).toISOString()).toBe(at(20).toISOString());
  });

  it("is refused as stale when a booked visit changed since the proposal was shown", async () => {
    const { fixtures, order } = await fitout();
    const ray = await tech("Ray Nunez");
    const moving = await visit(fixtures.id, ray, at(17));
    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(seen.proposal!.visits.moves).toHaveLength(1);
    await raw`update public.visit set window_start = ${at(17, "11:00")} where id = ${moving}`;
    await expect(scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: seen.proposal!.key }))
      .rejects.toThrow(/or a booked visit did/);
  });

  it("lets a customer service seat apply days that move no booked visit", async () => {
    const { order } = await fitout();
    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(seen.proposal!.visits).toEqual({ moves: [], left: [] });
    const done = await scheduling.applyChangeOrderDays(as(["csr"]), { id: order, proposalKey: seen.proposal!.key });
    expect(done.applied!.visits).toEqual({ moved: [], left: [] });
  });
});
