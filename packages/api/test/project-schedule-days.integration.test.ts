import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import * as changeOrders from "../src/services/project-change-orders";
import * as scheduling from "../src/services/project-schedule";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M12. THE SCHEDULE: A CHANGE ORDER'S DAYS, AND WHO IS BOOKED TWICE.
 *
 * THE DAYS MOVE THE SCHEDULE ONLY WHEN A PERSON APPLIES THEM, as they were
 * shown, once. Looking at the proposal moves nothing, and a proposal that has
 * gone stale is not applied.
 *
 * A CLASH IS FLAGGED AND NOBODY IS MOVED.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m12days:org");
const USER = fixtureId("m12days:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = () => as(["owner"]);

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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fitout Days Co", slug: "fitout-days-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, email)
    values (${ORG}, 'commercial', 'Hillcrest Partners', 'owner@hillcrest.test') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '14 Hillcrest', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
});

/** Rough in, then fixtures waiting for it, then paint waiting for fixtures. */
async function fitout() {
  const project = await projects.create(owner(), {
    customerId, propertyId, name: "Hillcrest fit out", contractValue: "100000",
  });
  const rough = await projects.addPhase(owner(), {
    projectId: project.id, name: "Rough in", billingValue: "50000",
    startsOn: "2026-11-02", endsOn: "2026-11-13",
  });
  const fixtures = await projects.addPhase(owner(), {
    projectId: project.id, name: "Fixtures", billingValue: "30000",
    dependsOnPhaseId: rough.id, startsOn: "2026-11-16", endsOn: "2026-11-20",
  });
  const paint = await projects.addPhase(owner(), {
    projectId: project.id, name: "Paint", billingValue: "20000",
    dependsOnPhaseId: fixtures.id, startsOn: "2026-11-23", endsOn: "2026-11-24",
  });
  return { project, rough, fixtures, paint };
}

/** A priced change order, agreed by the office, carrying days. */
async function agreed(projectId: string, days: number | null, phaseId: string | null, title = "Two more circuits") {
  const order = await changeOrders.request(owner(), {
    projectId, title, phaseId, scheduleDays: days,
  });
  await changeOrders.addLine(owner(), { changeOrderId: order.id, name: title, quantity: "1", unitPrice: "900" });
  await changeOrders.decide(owner(), { id: order.id, decision: "approved", signerName: "Pat Owner" });
  return order.id;
}

const datesOf = async (projectId: string) =>
  Object.fromEntries((await scheduling.schedule(owner(), { projectId })).phases.map((p) => [p.name, `${p.startsOn} to ${p.endsOn}`]));

run("the days a change order adds", () => {
  it("proposes first, moves nothing until a person applies it, and then moves the later phases", async () => {
    const { project, rough } = await fitout();
    const order = await agreed(project.id, 3, rough.id);
    const before = await datesOf(project.id);

    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(seen).toMatchObject({ canApply: true, reason: null, days: 3, phaseName: "Rough in", applied: null });
    expect(seen.proposal!.changes.map((c) => [c.name, c.startsOn, c.endsOn])).toEqual([
      ["Rough in", "2026-11-02", "2026-11-16"],
      ["Fixtures", "2026-11-19", "2026-11-23"],
      ["Paint", "2026-11-26", "2026-11-27"],
    ]);
    expect(seen.proposal).toMatchObject({ finishBefore: "2026-11-24", finishAfter: "2026-11-27" });
    expect(seen.proposal!.statement).toBe(
      "Adds 3 days to Rough in and moves 2 later phases out by the same. The finish moves from 2026-11-24 to 2026-11-27.",
    );
    /** Looking is not applying. */
    expect(await datesOf(project.id)).toEqual(before);

    /** Not what was shown. */
    await expect(scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: "nope" }))
      .rejects.toThrow(/Look at it again/);
    expect(await datesOf(project.id)).toEqual(before);

    const done = await scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: seen.proposal!.key });
    expect(done.alreadyApplied).toBe(false);
    expect(done.applied).toMatchObject({ phaseId: rough.id, days: 3 });
    expect(await datesOf(project.id)).toEqual({
      "Rough in": "2026-11-02 to 2026-11-16",
      Fixtures: "2026-11-19 to 2026-11-23",
      Paint: "2026-11-26 to 2026-11-27",
    });
    const [row] = await raw<{ schedule_applied_by: string; schedule_applied_at: Date }[]>`
      select schedule_applied_by, schedule_applied_at from public.project_change_order where id = ${order}`;
    expect(row!.schedule_applied_by).toBe(USER);
    expect(row!.schedule_applied_at).toBeInstanceOf(Date);
    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log where action = 'project_change_order.schedule_applied' and entity_id = ${order}`;
    expect(audit!.n).toBe(1);

    /** A retry, or a colleague pressing the same button, moves nothing further. */
    const again = await scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: seen.proposal!.key });
    expect(again.alreadyApplied).toBe(true);
    expect(await datesOf(project.id)).toEqual({
      "Rough in": "2026-11-02 to 2026-11-16",
      Fixtures: "2026-11-19 to 2026-11-23",
      Paint: "2026-11-26 to 2026-11-27",
    });
    const after = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(after).toMatchObject({ canApply: false, reason: "These days are already on the schedule." });
    expect(after.applied!.changes).toHaveLength(3);
  });

  it("refuses a proposal that went stale because somebody moved a phase after it was shown", async () => {
    const { project, rough, fixtures } = await fitout();
    const order = await agreed(project.id, 2, rough.id);
    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    await scheduling.move(owner(), { id: fixtures.id, startsOn: "2026-11-17" });
    await expect(scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: seen.proposal!.key }))
      .rejects.toThrow(/schedule changed since you looked/);
    const fresh = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    await scheduling.applyChangeOrderDays(owner(), { id: order, proposalKey: fresh.proposal!.key });
    expect((await datesOf(project.id))["Fixtures"]).toBe("2026-11-19 to 2026-11-23");
  });

  it("will not move the schedule for a change order the customer has not agreed", async () => {
    const { project, rough } = await fitout();
    const order = await changeOrders.request(owner(), { projectId: project.id, title: "Maybe", phaseId: rough.id, scheduleDays: 4 });
    await changeOrders.addLine(owner(), { changeOrderId: order.id, name: "Maybe", quantity: "1", unitPrice: "100" });
    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: order.id });
    expect(seen).toMatchObject({ canApply: false, proposal: null, reason: "Only a change order the customer has agreed can move the schedule." });
    await expect(scheduling.applyChangeOrderDays(owner(), { id: order.id, proposalKey: "x" }))
      .rejects.toThrow(/Only a change order the customer has agreed/);
  });

  it("asks which phase when the change order names none, and lands the days on the one chosen", async () => {
    const { project, fixtures } = await fitout();
    const order = await agreed(project.id, 2, null);
    const open = await scheduling.proposeChangeOrderDays(owner(), { id: order });
    expect(open).toMatchObject({ canApply: false, reason: expect.stringMatching(/Choose the phase/) });

    const chosen = await scheduling.proposeChangeOrderDays(owner(), { id: order, phaseId: fixtures.id });
    expect(chosen.proposal!.changes.map((c) => c.name)).toEqual(["Fixtures", "Paint"]);
    await scheduling.applyChangeOrderDays(owner(), { id: order, phaseId: fixtures.id, proposalKey: chosen.proposal!.key });
    expect(await datesOf(project.id)).toEqual({
      "Rough in": "2026-11-02 to 2026-11-13",
      Fixtures: "2026-11-16 to 2026-11-22",
      Paint: "2026-11-25 to 2026-11-26",
    });
  });

  it("takes days off a phase, and says when it cannot", async () => {
    const { project, rough } = await fitout();
    const saves = await agreed(project.id, -2, rough.id, "Dropped the closet");
    const seen = await scheduling.proposeChangeOrderDays(owner(), { id: saves });
    expect(seen.proposal!.statement).toMatch(/^Takes off 2 days from Rough in and moves 2 later phases in by the same\./);
    await scheduling.applyChangeOrderDays(owner(), { id: saves, proposalKey: seen.proposal!.key });
    expect((await datesOf(project.id))["Rough in"]).toBe("2026-11-02 to 2026-11-11");

    const tooMuch = await agreed(project.id, -30, rough.id, "Everything");
    expect(await scheduling.proposeChangeOrderDays(owner(), { id: tooMuch }))
      .toMatchObject({ canApply: false, reason: expect.stringMatching(/cannot give up 30/) });
  });

  it("refuses a phase that is complete, and the same days on a project whose later phase is complete", async () => {
    const { project, rough, fixtures } = await fitout();
    await raw`update public.project_phase set status = 'complete' where id = ${fixtures.id}`;
    const order = await agreed(project.id, 2, rough.id);
    expect(await scheduling.proposeChangeOrderDays(owner(), { id: order }))
      .toMatchObject({ canApply: false, reason: expect.stringMatching(/Fixtures waits for Rough in and is already complete/) });
    await raw`update public.project_phase set status = 'complete' where id = ${rough.id}`;
    expect(await scheduling.proposeChangeOrderDays(owner(), { id: order }))
      .toMatchObject({ canApply: false, reason: "Rough in is complete, so its dates are what happened." });
  });

  it("needs job:write to apply and job:read to look", async () => {
    const { project, rough } = await fitout();
    const order = await agreed(project.id, 1, rough.id);
    const seen = await scheduling.proposeChangeOrderDays(as(["dispatcher"]), { id: order });
    expect(seen.canApply).toBe(true);
    await expect(scheduling.applyChangeOrderDays(as(["accountant"]), { id: order, proposalKey: seen.proposal!.key }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(scheduling.proposeChangeOrderDays(as(["accountant"]), { id: order })).resolves.toBeDefined();
    await scheduling.applyChangeOrderDays(as(["dispatcher"]), { id: order, proposalKey: seen.proposal!.key });
    expect((await datesOf(project.id))["Rough in"]).toBe("2026-11-02 to 2026-11-14");
  });
});

run("a person booked on two phases at once", () => {
  async function tech(name: string) {
    const [membership] = await raw<{ id: string }[]>`
      select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
    const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
      values (${ORG}, ${membership!.id}, ${name}) returning id`;
    return row!.id;
  }
  async function visit(phaseId: string, technicianId: string, at: string, status = "scheduled") {
    const [link] = await raw<{ job_id: string }[]>`
      select job_id from public.project_job where project_phase_id = ${phaseId}`;
    const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${link!.job_id}, ${status}::visit_status, ${at}::timestamptz, ${at}::timestamptz + interval '3 hours') returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${technicianId})`;
  }

  it("is marked with who and when, and nobody is moved", async () => {
    const { project, rough } = await fitout();
    /** Electrical runs Nov 10 to 18, which overlaps rough in on Nov 10 to 13. */
    const electrical = await projects.addPhase(owner(), {
      projectId: project.id, name: "Electrical", startsOn: "2026-11-10", endsOn: "2026-11-18",
    });
    await projects.materialise(owner(), { id: project.id });
    const ray = await tech("Ray Nunez");
    const sam = await tech("Sam Ortiz");
    /** 9am Central on the 11th and the 12th. */
    await visit(rough.id, ray, "2026-11-11T15:00:00Z");
    await visit(electrical.id, ray, "2026-11-12T15:00:00Z");
    /** Sam is on both phases but not on the days they overlap. */
    await visit(rough.id, sam, "2026-11-03T15:00:00Z");
    await visit(electrical.id, sam, "2026-11-17T15:00:00Z");

    const before = await datesOf(project.id);
    const schedule = await scheduling.schedule(owner(), { projectId: project.id });
    expect(schedule.clashes).toHaveLength(1);
    expect(schedule.clashes[0]).toMatchObject({
      kind: "technician", id: ray, name: "Ray Nunez", from: "2026-11-10", to: "2026-11-13", visits: [1, 1],
      statement: "Ray Nunez is booked on Rough in and Electrical, which both run from 2026-11-10 to 2026-11-13.",
    });
    expect(schedule.phases.find((p) => p.id === rough.id)!.clashes).toHaveLength(1);
    expect(schedule.phases.find((p) => p.id === electrical.id)!.clashes).toHaveLength(1);
    expect(schedule.phases.find((p) => p.name === "Fixtures")!.clashes).toEqual([]);
    /** Reading the schedule moved nobody. */
    expect(await datesOf(project.id)).toEqual(before);
    const [{ n } = { n: -1 }] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.visit_assignment where technician_id = ${ray}`;
    expect(n).toBe(2);
  });

  it("does not count a visit that is over or cancelled, or a day outside the overlap", async () => {
    const { project, rough } = await fitout();
    const electrical = await projects.addPhase(owner(), {
      projectId: project.id, name: "Electrical", startsOn: "2026-11-10", endsOn: "2026-11-18",
    });
    await projects.materialise(owner(), { id: project.id });
    const ray = await tech("Ray Nunez");
    await visit(rough.id, ray, "2026-11-11T15:00:00Z", "completed");
    await visit(electrical.id, ray, "2026-11-12T15:00:00Z");
    expect((await scheduling.schedule(owner(), { projectId: project.id })).clashes).toEqual([]);
    await visit(rough.id, ray, "2026-11-11T15:00:00Z", "cancelled");
    expect((await scheduling.schedule(owner(), { projectId: project.id })).clashes).toEqual([]);
  });
});
