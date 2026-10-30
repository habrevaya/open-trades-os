import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor, type field } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as kpis from "../src/services/kpis";
import * as visits from "../src/services/visits";
import * as cancellations from "../src/services/visit-cancellations";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A TEAM TURNED AWAY AT THE DOOR CALLS THE VISIT OFF FROM THE FIELD
 *
 * `visit.call_off` from the phone's queue, through the real sync: who asked
 * (the customer turning them away, or the company with one of the office's
 * reason codes) and the time it was pressed, accepted only for a visit on the
 * technician's own day that nobody has started, and landing exactly as the
 * office's call off does: the same columns, the same audit entry, the same
 * cancellation figures.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("fco:org");
const OWNER = fixtureId("fco:owner");
const RAY = fixtureId("fco:ray");
const SAM = fixtureId("fco:sam");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const tech = (userId: string, technicianId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId }, db: db(),
});
let rayTech = "";
let samTech = "";
const ray = () => tech(RAY, rayTech);
const sam = () => tech(SAM, samTech);
let customerId = "";
let propertyId = "";
let typeId = "";
let seq = 0;

async function technician(userId: string, name: string): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@fco.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Field Call Off Cleaning Co", slug: "field-call-off-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'cleaning' where id = ${ORG}`;
  rayTech = await technician(RAY, "Ray Nunez");
  samTech = await technician(SAM, "Sam Ortiz");
  const [customer] = await raw`insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Rosa Reyes', 0) returning id`;
  customerId = customer!.id as string;
  const [property] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Willow', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id as string;
  const [type] = await raw`insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'recurring', 'fco-recurring', 'route', 'recurring') returning id`;
  typeId = type!.id as string;
});
afterAll(async () => { if (raw) await raw.end(); });

/** A visit at eleven in the morning on a company day, on Ray's day unless said otherwise, booked two days ago. */
async function visitOn(opts: { day?: string; status?: string; technicianId?: string | null; crew?: boolean } = {}) {
  seq += 1;
  const start = new Date(`${opts.day ?? companyToday()}T16:00:00Z`);
  const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${typeId}, 'scheduled', 'Clean') returning id`;
  const [visit] = await raw`insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end, created_at)
    values (${ORG}, ${job!.id}, 1, ${opts.status ?? "dispatched"}, ${start}, ${new Date(start.getTime() + 7_200_000)}, now() - interval '2 days')
    returning id`;
  const who = opts.technicianId === undefined ? rayTech : opts.technicianId;
  if (opts.crew && who) {
    const [crew] = await raw`insert into public.crew (organization_id, name) values (${ORG}, ${`Crew ${seq}`}) returning id`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crew!.id}, ${who})`;
    await raw`update public.visit set crew_id = ${crew!.id} where id = ${visit!.id}`;
  } else if (who) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visit!.id}, ${who})`;
  }
  return { jobId: job!.id as string, visitId: visit!.id as string };
}

async function send(ctx: ServiceContext, ops: Array<{ kind: field.OperationKind; subjectId: string; payload?: Record<string, unknown>; occurredAt?: Date }>) {
  const device = await fieldOps.register(ctx, { installationId: `fco-${crypto.randomUUID()}` });
  const result = await fieldOps.sync(ctx, {
    deviceId: device.deviceId,
    operations: ops.map((op, i) => ({
      clientId: crypto.randomUUID(), sequence: i + 1, kind: op.kind, subjectId: op.subjectId,
      occurredAt: (op.occurredAt ?? new Date(Date.now() - (ops.length - i) * 1000)).toISOString(),
      payload: op.payload ?? {},
    })),
  });
  return result.results;
}

const visitRow = async (id: string) => (await raw<{
  status: string; cancelled_by: string | null; cancelled_at: Date | null; cancel_notice_hours: number | null;
  cancel_reason: string | null; cancel_reason_note: string | null; technician_notes: string | null; route_order: number | null;
}[]>`select status::text, cancelled_by::text as cancelled_by, cancelled_at, cancel_notice_hours,
       cancel_reason::text as cancel_reason, cancel_reason_note, technician_notes, route_order
     from public.visit where id = ${id}`)[0]!;

const auditOf = async (id: string) => raw<{ actor_user_id: string | null; before: unknown; after: Record<string, unknown> }[]>`
  select actor_user_id, before, after from public.audit_log
  where organization_id = ${ORG} and entity_id = ${id} and action = 'visit.called_off'`;

run("calling a visit off from the field", () => {
  it("records a team turned away as the customer's cancellation, at the time it was pressed, as the office would", async () => {
    const { visitId } = await visitOn({ status: "en_route" });
    const at = new Date(Date.now() - 5 * 60_000);
    const [result] = await send(ray(), [{
      kind: "visit.call_off", subjectId: visitId, payload: { by: "customer", note: "Said they fixed it themselves" }, occurredAt: at,
    }]);
    expect([result!.status, result!.rejection]).toEqual(["applied", null]);

    const row = await visitRow(visitId);
    expect(row).toMatchObject({ status: "cancelled", cancelled_by: "customer", cancel_notice_hours: 24, cancel_reason: null, route_order: null });
    expect(Math.abs(row.cancelled_at!.getTime() - at.getTime())).toBeLessThan(1000);
    expect(row.technician_notes).toContain("Turned away at the door: Said they fixed it themselves");

    /** The same audit entry as the office's, by the person at the door, saying it came from the phone. */
    const [audited] = await auditOf(visitId);
    expect(audited).toMatchObject({ actor_user_id: RAY, after: { status: "cancelled", cancelledBy: "customer", cancelNoticeHours: 24, from: "phone" } });
    expect(audited!.after).not.toHaveProperty("reason");

    /** The visit's page reads it the same way it reads the office's. */
    const page = await visits.get(owner(), { id: visitId });
    expect(page.cancellation).toMatchObject({ by: "customer", noticeHours: 24, late: true, reason: null });
  });

  it("records the company's own day off with the office's reason codes and words", async () => {
    const { visitId } = await visitOn();
    const [result] = await send(ray(), [{
      kind: "visit.call_off", subjectId: visitId, payload: { by: "company", reason: { code: "crew_short", note: " Two out sick " } },
    }]);
    expect(result!.status).toBe("applied");
    expect(await visitRow(visitId)).toMatchObject({ cancelled_by: "company", cancel_reason: "crew_short", cancel_reason_note: "Two out sick" });
    const [audited] = await auditOf(visitId);
    expect(audited!.after).toMatchObject({ cancelledBy: "company", reason: "crew_short", reasonNote: "Two out sick", from: "phone" });
  });

  it("lands in the cancellation figures exactly where the office's own call off lands", async () => {
    const day = companyToday();
    const window = { from: day, to: day };
    const phoneCustomer = (await visitOn()).visitId;
    const phoneCompany = (await visitOn()).visitId;
    const officeCustomer = (await visitOn()).visitId;
    const officeCompany = (await visitOn()).visitId;
    await send(ray(), [
      { kind: "visit.call_off", subjectId: phoneCustomer, payload: { by: "customer" } },
      { kind: "visit.call_off", subjectId: phoneCompany, payload: { by: "company", reason: { code: "weather" } } },
    ]);
    await cancellations.cancel(owner(), { id: officeCustomer, by: "customer" });
    await cancellations.cancel(owner(), { id: officeCompany, by: "company", reason: { code: "weather" } });

    const late = (await kpis.drill(owner(), { key: "cancel_rate_route", half: "numerator", ...window })).records.map((r) => r.id);
    const company = (await kpis.drill(owner(), { key: "cancel_rate_route", half: "excluded", ...window })).records;
    expect(late).toEqual(expect.arrayContaining([phoneCustomer, officeCustomer]));
    expect(company.map((r) => r.id)).toEqual(expect.arrayContaining([phoneCompany, officeCompany]));
    /** The record says why, the same words for the phone's as for the office's. */
    expect(company.find((r) => r.id === phoneCompany)!.label).toMatch(/Rain or weather$/);
    expect(company.find((r) => r.id === officeCompany)!.label).toMatch(/Rain or weather$/);
  });

  it("takes a crew member's call off for the crew's visit", async () => {
    const { visitId } = await visitOn({ crew: true });
    const [result] = await send(ray(), [{ kind: "visit.call_off", subjectId: visitId, payload: { by: "customer" } }]);
    expect(result!.status).toBe("applied");
    expect((await visitRow(visitId)).status).toBe("cancelled");
  });

  it("refuses a visit on somebody else's day, or on another day, in words, and changes nothing", async () => {
    const theirs = (await visitOn({ technicianId: samTech })).visitId;
    const tomorrow = (await visitOn({ day: companyToday(1) })).visitId;
    const results = await send(ray(), [
      { kind: "visit.call_off", subjectId: theirs, payload: { by: "customer" } },
      { kind: "visit.call_off", subjectId: tomorrow, payload: { by: "customer" } },
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(results[0]!.rejection).toBe("That visit is not on your day, so it cannot be called off from your phone. Ring the office.");
    expect(results[1]!.rejection).toBe("That visit is not on your day today, so it cannot be called off from your phone. Ring the office.");
    expect((await visitRow(theirs)).status).toBe("dispatched");
    expect((await visitRow(tomorrow)).status).toBe("dispatched");
    /** Sam, whose day it is, may. */
    const [mine] = await send(sam(), [{ kind: "visit.call_off", subjectId: theirs, payload: { by: "customer" } }]);
    expect(mine!.status).toBe("applied");
  });

  it("refuses one already started or already called off, and keeps the first call off as it was", async () => {
    const working = (await visitOn({ status: "working" })).visitId;
    const office = (await visitOn()).visitId;
    await cancellations.cancel(owner(), { id: office, by: "company", reason: { code: "equipment" } });
    const results = await send(ray(), [
      { kind: "visit.call_off", subjectId: working, payload: { by: "customer" } },
      { kind: "visit.call_off", subjectId: office, payload: { by: "customer" } },
    ]);
    expect(results.map((r) => [r.status, r.rejection])).toEqual([
      ["rejected", "Cannot visit.call_off from working"],
      ["rejected", "Cannot visit.call_off from cancelled"],
    ]);
    expect((await visitRow(working)).status).toBe("working");
    expect(await visitRow(office)).toMatchObject({ cancelled_by: "company", cancel_reason: "equipment" });
    expect((await auditOf(office)).length).toBe(1);
  });

  it("asks who and why exactly as the office's form does, and never gives a customer's a reason", async () => {
    const { visitId } = await visitOn();
    const results = await send(ray(), [
      { kind: "visit.call_off", subjectId: visitId, payload: {} },
      { kind: "visit.call_off", subjectId: visitId, payload: { by: "company" } },
      { kind: "visit.call_off", subjectId: visitId, payload: { by: "company", reason: { code: "other" } } },
      { kind: "visit.call_off", subjectId: visitId, payload: { by: "customer", reason: { code: "weather" } } },
    ]);
    expect(results.map((r) => r.rejection)).toEqual([
      "Say who called it off: the customer, or us and why.",
      "Say why we called it off: rain or weather, crew short, equipment, or something else.",
      "Say what the reason was, in a few words.",
      "Only a day the company called off has a reason. A customer is not asked why they cancelled.",
    ]);
    expect((await visitRow(visitId)).status).toBe("dispatched");
  });

  it("is written once when the phone sends it again", async () => {
    const { visitId } = await visitOn();
    const device = await fieldOps.register(ray(), { installationId: `fco-again-${crypto.randomUUID()}` });
    const op = {
      clientId: crypto.randomUUID(), sequence: 1, kind: "visit.call_off" as const, subjectId: visitId,
      occurredAt: new Date().toISOString(), payload: { by: "customer" },
    };
    const first = await fieldOps.sync(ray(), { deviceId: device.deviceId, operations: [op] });
    const again = await fieldOps.sync(ray(), { deviceId: device.deviceId, operations: [op] });
    expect(first.results[0]!.status).toBe("applied");
    expect(again.results[0]!.status).toBe("applied");
    expect((await auditOf(visitId)).length).toBe(1);
  });
});
