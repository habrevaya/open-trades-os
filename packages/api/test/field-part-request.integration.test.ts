import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, can, type Actor, type field } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as dispatchSvc from "../src/services/dispatch";
import * as jobHolds from "../src/services/job-holds";
import * as partRequests from "../src/services/part-requests";
import * as tasks from "../src/services/tasks";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * A TECHNICIAN ASKS FOR A PART FROM THE FIELD; THE OFFICE PLACES THE HOLD
 *
 * `part.request` through the real sync: the part in words from a visit the
 * person is on raises one office task naming the job, the part and who asked,
 * and keeps the request on the job. The phone never places a hold. Whoever
 * orders the part places the real hold against the purchase order from that
 * task (`partRequestId`), which links the hold to the request and finishes the
 * task.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("fpr:org");
const OWNER = fixtureId("fpr:owner");
const RAY = fixtureId("fpr:ray");
const SAM = fixtureId("fpr:sam");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const as = (role: string): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db() });
const tech = (userId: string, technicianId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId }, db: db(),
});
let rayTech = "";
let samTech = "";
const ray = () => tech(RAY, rayTech);
let customerId = "";
let propertyId = "";
let vendorId = "";
let locationId = "";
let seq = 0;

async function technician(userId: string, name: string): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@fpr.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Field Part Request Co", slug: "field-part-request-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  rayTech = await technician(RAY, "Ray Nunez");
  samTech = await technician(SAM, "Sam Ortiz");
  const [customer] = await raw`insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Dana Whitfield', 0) returning id`;
  customerId = customer!.id as string;
  const [property] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Oak', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id as string;
  const [vendor] = await raw`insert into public.vendor (organization_id, name) values (${ORG}, 'Supply House') returning id`;
  vendorId = vendor!.id as string;
  const [location] = await raw`insert into public.location (organization_id, name) values (${ORG}, 'Shop') returning id`;
  locationId = location!.id as string;
});
afterAll(async () => { if (raw) await raw.end(); });

/** A job under way with one visit today on Ray's day (or whoever is named). */
async function underWay(technicianId: string = rayTech, status = "in_progress") {
  seq += 1;
  const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${status}, 'No cool') returning id`;
  const start = new Date(`${companyToday()}T15:00:00Z`);
  const [visit] = await raw`insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 1, 'working', ${start}, ${new Date(start.getTime() + 7_200_000)}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visit!.id}, ${technicianId})`;
  return { jobId: job!.id as string, visitId: visit!.id as string };
}

async function sentOrder(): Promise<{ id: string; number: number }> {
  seq += 1;
  const number = 9000 + seq;
  const [row] = await raw`insert into public.purchase_order (organization_id, number, vendor_id, default_location_id, status, submitted_at)
    values (${ORG}, ${number}, ${vendorId}, ${locationId}, 'submitted', now()) returning id`;
  return { id: row!.id as string, number };
}

async function send(ctx: ServiceContext, ops: Array<{ kind: field.OperationKind; subjectId: string; payload?: Record<string, unknown> }>) {
  const device = await fieldOps.register(ctx, { installationId: `fpr-${crypto.randomUUID()}` });
  const operations = ops.map((op, i) => ({
    clientId: crypto.randomUUID(), sequence: i + 1, kind: op.kind, subjectId: op.subjectId,
    occurredAt: new Date(Date.now() - (ops.length - i) * 1000).toISOString(), payload: op.payload ?? {},
  }));
  const result = await fieldOps.sync(ctx, { deviceId: device.deviceId, operations });
  return { results: result.results, deviceId: device.deviceId, operations };
}

const ask = (visitId: string, part: string, note?: string) => ({
  kind: "part.request" as const, subjectId: crypto.randomUUID(), payload: { visitId, part, ...(note ? { note } : {}) },
});

run("asking for a part from the field", () => {
  it("raises one office task naming the job, the part and who asked, and keeps the request on the job", async () => {
    const { jobId, visitId } = await underWay();
    const request = ask(visitId, "Condenser fan motor, 1/4 hp", "Model on the plate is 24ACC6");
    const { results } = await send(ray(), [request]);
    expect([results[0]!.status, results[0]!.rejection]).toEqual(["applied", null]);

    const { data } = await partRequests.forJob(owner(), { id: jobId });
    expect(data).toEqual([expect.objectContaining({
      id: request.subjectId, jobId, visitId, part: "Condenser fan motor, 1/4 hp", note: "Model on the plate is 24ACC6",
      requestedBy: "Ray Nunez", taskStatus: "open", holdId: null, purchaseOrderId: null,
    })]);

    const task = await tasks.get(owner(), { id: data[0]!.taskId! });
    expect(task).toMatchObject({
      title: `Part needed for job ${seq}: Condenser fan motor, 1/4 hp`,
      entityType: "job", entityId: jobId, queue: "office", assigneeUserId: null, status: "open",
    });
    expect(task.body).toContain("Ray Nunez asked for this part from Dana Whitfield, 12 Oak (No cool): Condenser fan motor, 1/4 hp.");
    expect(task.body).toContain("They said: Model on the plate is 24ACC6");

    /** Never a hold: the job is as it was. */
    expect((await jobHolds.holdsOf(owner(), { id: jobId })).data).toEqual([]);
    const [job] = await raw`select status::text from public.job where id = ${jobId}`;
    expect(job!.status).toBe("in_progress");

    /** The phone's day carries it, in words, with whether the office has held the job for it. */
    const device = await fieldOps.register(ray(), { installationId: `fpr-day-${crypto.randomUUID()}` });
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 1 });
    expect(day.visits.find((v) => v.id === visitId)!.partsAsked).toEqual([expect.objectContaining({
      id: request.subjectId, part: "Condenser fan motor, 1/4 hp", held: false,
    })]);
  });

  it("writes it once when the phone sends it again", async () => {
    const { jobId, visitId } = await underWay();
    const request = ask(visitId, "Contactor 40A");
    const first = await send(ray(), [request]);
    const again = await fieldOps.sync(ray(), { deviceId: first.deviceId, operations: first.operations });
    expect(again.results[0]!.status).toBe("applied");
    /** A second phone sending the same id is the same request, too. */
    const { results } = await send(ray(), [request]);
    expect(results[0]!.status).toBe("applied");
    expect((await partRequests.forJob(owner(), { id: jobId })).data).toHaveLength(1);
    const [tasksRaised] = await raw`select count(*)::int as n from public.task where entity_id = ${jobId}`;
    expect(tasksRaised!.n).toBe(1);
  });

  it("refuses one from a visit that is not theirs, one with no part, and one on a cancelled job, in words", async () => {
    const theirs = await underWay(samTech);
    const mine = await underWay();
    const cancelled = await underWay(rayTech, "cancelled");
    const { results } = await send(ray(), [
      ask(theirs.visitId, "Motor"),
      ask(mine.visitId, "   "),
      ask(cancelled.visitId, "Motor"),
    ]);
    expect(results.map((r) => r.rejection)).toEqual([
      "That visit is not one of yours, so you cannot ask for a part on it from your phone. Ring the office.",
      "Say what part you need, in a few words.",
      "That job was cancelled, so no part is needed for it. Ring the office if it is.",
    ]);
    const [left] = await raw`select count(*)::int as n from public.part_request where organization_id = ${ORG}
      and job_id in (${theirs.jobId}, ${mine.jobId}, ${cancelled.jobId})`;
    expect(left!.n).toBe(0);
  });
});

run("the office places the hold from the task", () => {
  it("puts the job on hold against the order, links the hold to the request and finishes the task", async () => {
    const { jobId, visitId } = await underWay();
    const request = ask(visitId, "Condenser fan motor");
    await send(ray(), [request]);
    const [asked] = (await partRequests.forJob(owner(), { id: jobId })).data;
    expect((await partRequests.forTask(owner(), { taskId: asked!.taskId! }))!.id).toBe(request.subjectId);

    const order = await sentOrder();
    const held = await jobHolds.place(owner(), {
      id: jobId, reason: "part", purchaseOrderId: order.id, note: "Condenser fan motor", partRequestId: request.subjectId,
    });
    const hold = held.data.find((h) => h.releasedAt === null)!;
    expect(hold).toMatchObject({ reason: "part", purchaseOrderId: order.id, purchaseOrderNumber: order.number });

    const [after] = (await partRequests.forJob(owner(), { id: jobId })).data;
    expect(after).toMatchObject({ holdId: hold.id, purchaseOrderId: order.id, purchaseOrderNumber: order.number, taskStatus: "done" });
    const task = await tasks.get(owner(), { id: asked!.taskId! });
    expect(task).toMatchObject({ status: "done", outcome: `The job is on hold for the part on purchase order ${order.number}.` });
    const audited = await raw`select after from public.audit_log where organization_id = ${ORG}
      and entity_id = ${request.subjectId} and action = 'part_request.held'`;
    expect(audited[0]!.after).toMatchObject({ holdId: hold.id, purchaseOrderId: order.id });

    /** The phone hears the job is held for it. */
    const device = await fieldOps.register(ray(), { installationId: `fpr-held-${crypto.randomUUID()}` });
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 1 });
    expect(day.visits.find((v) => v.id === visitId)!.partsAsked![0]!.held).toBe(true);
  });

  it("answers a request once, only with a part hold, and only on its own job", async () => {
    const one = await underWay();
    const other = await underWay();
    const request = ask(one.visitId, "Blower wheel");
    await send(ray(), [request]);
    const order = await sentOrder();

    await expect(jobHolds.place(owner(), { id: other.jobId, reason: "part", purchaseOrderId: order.id, partRequestId: request.subjectId }))
      .rejects.toBeInstanceOf(NotFoundError);
    await expect(jobHolds.place(owner(), { id: one.jobId, reason: "customer", partRequestId: request.subjectId }))
      .rejects.toThrow("A part asked for from the field is held for as a part, on the order it is on.");
    const held = await jobHolds.place(owner(), { id: one.jobId, reason: "part", purchaseOrderId: order.id, partRequestId: request.subjectId });
    await jobHolds.release(owner(), { id: held.data[0]!.id });
    await expect(jobHolds.place(owner(), { id: one.jobId, reason: "part", purchaseOrderId: order.id, partRequestId: request.subjectId }))
      .rejects.toThrow(ConflictError);
  });

  it("is the office's: a technician cannot place it, and reading the order on a request needs po:read", async () => {
    const { jobId, visitId } = await underWay();
    const request = ask(visitId, "Igniter");
    await send(ray(), [request]);
    const order = await sentOrder();
    await expect(jobHolds.place(ray(), { id: jobId, reason: "part", purchaseOrderId: order.id, partRequestId: request.subjectId }))
      .rejects.toBeInstanceOf(PermissionError);
    await jobHolds.place(owner(), { id: jobId, reason: "part", purchaseOrderId: order.id, partRequestId: request.subjectId });

    const [seen] = (await partRequests.forJob(as("dispatcher"), { id: jobId })).data;
    expect(seen!.holdId).not.toBeNull();
    if (!can(as("dispatcher").actor, "po:read")) expect(seen).toMatchObject({ purchaseOrderId: null, purchaseOrderNumber: null });
    else expect(seen!.purchaseOrderNumber).toBe(order.number);
  });
});
