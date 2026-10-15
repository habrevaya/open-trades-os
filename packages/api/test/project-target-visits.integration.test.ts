import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import * as changeOrders from "../src/services/project-change-orders";
import * as scheduling from "../src/services/project-schedule";
import { windowStart } from "../src/services/booking";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M12. THE VISITS ON THE PHASE A CHANGE ORDER'S DAYS LAND ON.
 *
 * Rough in runs from day 10 to day 14, then fixtures. A change order adds
 * three days to rough in. Left as it is, the days go on the end of rough in
 * and only fixtures' visits move. Told the extra work starts on day 12, rough
 * in's visits from day 12 go three days later too, held to the same refusals,
 * and the ones before stay. A day outside the phase is refused in words. A
 * change order that takes two days off from day 11 leaves rough in's visit on
 * a day taken off where it is, named, and brings the ones after in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m12target:org");
const USER = fixtureId("m12target:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: testDb(url!) });
/** Calendar days from today, so a day the clocks change is still one day. */
const day = (n: number) => time.addDays(companyToday(), n);
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Landing Days Co", slug: "landing-days-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, email)
    values (${ORG}, 'commercial', 'Oak Ridge Partners', 'owner@oakridge.test') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Oak Ridge', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
});

async function tech(name: string) {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return row!.id;
}

async function visit(phaseId: string, technicianId: string, start: Date) {
  const [link] = await raw<{ job_id: string }[]>`select job_id from public.project_job where project_phase_id = ${phaseId}`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${link!.job_id}, 'scheduled', ${start}, ${new Date(start.getTime() + 3 * 3_600_000)}, 180) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${technicianId})`;
  return v!.id;
}

const startOf = async (visitId: string) =>
  (await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${visitId}`)[0]!.window_start;

/** Rough in, then fixtures, each with a job, and an agreed change order of some days on rough in. */
async function fitout(days: number) {
  const project = await projects.create(owner(), { customerId, propertyId, name: "Oak Ridge fit out", contractValue: "100000" });
  const rough = await projects.addPhase(owner(), {
    projectId: project.id, name: "Rough in", billingValue: "60000", startsOn: day(10), endsOn: day(14),
  });
  const fixtures = await projects.addPhase(owner(), {
    projectId: project.id, name: "Fixtures", billingValue: "40000", dependsOnPhaseId: rough.id, startsOn: day(17), endsOn: day(19),
  });
  await projects.materialise(owner(), { id: project.id });
  const order = await changeOrders.request(owner(), { projectId: project.id, title: "Rework", phaseId: rough.id, scheduleDays: days });
  await changeOrders.addLine(owner(), { changeOrderId: order.id, name: "Rework", quantity: "1", unitPrice: days > 0 ? "900" : "0" });
  await changeOrders.decide(owner(), { id: order.id, decision: "approved", signerName: "Pat Owner" });
  return { rough, fixtures, order: order.id };
}

run("the visits on the phase the days land on", () => {
  it("stay inside the phase when nobody says where the days start, and the days go on its end", async () => {
    const { rough, fixtures, order } = await fitout(3);
    const ray = await tech("Ray Nunez");
    await visit(rough.id, ray, at(11));
    await visit(rough.id, ray, at(13));
    const later = await visit(fixtures.id, ray, at(18));
    const days = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(days.proposal).toMatchObject({ from: day(15), fromChosen: false });
    expect(days.proposal!.visits.moves.map((m) => m.id)).toEqual([later]);
    expect(days.proposal!.visits.left).toEqual([]);
  });

  it("move from the day the person chooses, with the same refusals, and are applied as shown", async () => {
    const { rough, fixtures, order } = await fitout(3);
    const ray = await tech("Ray Nunez");
    const nia = await tech("Nia Osei");
    const before = await visit(rough.id, ray, at(11));
    const pushed = await visit(rough.id, ray, at(13));
    const booked = await visit(rough.id, nia, at(14));
    const later = await visit(fixtures.id, ray, at(18));
    /** Nia has another job on day 17, so her rough in visit cannot go. */
    const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'Service call') returning id`;
    const [other] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'scheduled', ${at(17, "10:00")}, ${at(17, "12:00")}, 120) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${other!.id}, ${nia})`;

    const days = await scheduling.proposeChangeOrderDays(owner(), { id: order, from: day(12) });
    expect(days.proposal).toMatchObject({ from: day(12), fromChosen: true });
    expect(days.proposal!.visits.moves.map((m) => [m.id, m.start.toISOString()])).toEqual([
      [pushed, at(16).toISOString()],
      [later, at(21).toISOString()],
    ]);
    expect(days.proposal!.visits.left).toEqual([expect.objectContaining({
      id: booked, reason: "Nia Osei is booked on another visit at the new time, so it stays where it is.",
    })]);

    /** The key was made with the day: applying it without the day is a different proposal. */
    await expect(scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: days.proposal!.key }))
      .rejects.toThrow(/Look at it again/);
    const applied = await scheduling.applyChangeOrderDays(owner(), { id: order, from: day(12), proposalKey: days.proposal!.key });
    expect(applied.applied).toMatchObject({ from: day(12) });
    expect(applied.applied!.visits.moved.map((m) => m.id)).toEqual([pushed, later]);
    expect((await startOf(before)).toISOString()).toBe(at(11).toISOString());
    expect((await startOf(pushed)).toISOString()).toBe(at(16).toISOString());
    expect((await startOf(booked)).toISOString()).toBe(at(14).toISOString());
    const [audit] = await raw<{ after: { reason?: string } }[]>`select after from public.audit_log
      where organization_id = ${ORG} and action = 'visit.moved_by_office' and entity_id = ${pushed}`;
    expect(audit).toBeDefined();
  });

  it("refuses a day outside the phase in words", async () => {
    const { order } = await fitout(3);
    const days = await scheduling.proposeChangeOrderDays(owner(), { id: order, from: day(9) });
    expect(days.canApply).toBe(false);
    expect(days.reason).toBe(`Choose a day from ${day(10)} to ${day(15)}, while Rough in runs, for where the extra days start.`);
  });

  it("leave a visit on a day taken off where it is, named, and bring the ones after in", async () => {
    const { rough, order } = await fitout(-2);
    const ray = await tech("Ray Nunez");
    const sam = await tech("Sam Ortiz");
    const first = await visit(rough.id, ray, at(10));
    const off = await visit(rough.id, ray, at(12));
    const after = await visit(rough.id, sam, at(14));
    const days = await scheduling.proposeChangeOrderDays(owner(), { id: order, from: day(11) });
    expect(days.proposal!.visits.left.map((l) => [l.id, l.reason])).toEqual([
      [off, "It is on a day the change order takes off, so it stays for the office to sort out."],
    ]);
    expect(days.proposal!.visits.moves.map((m) => [m.id, m.start.toISOString()])).toEqual([[after, at(12).toISOString()]]);
    expect(days.proposal!.visits.moves.some((m) => m.id === first)).toBe(false);
  });
});
