import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, reporting, type Actor } from "@opentradesos/core";
import * as permits from "../src/services/permit-inspections";
import * as compliance from "../src/services/compliance";
import * as kpis from "../src/services/kpis";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CITY'S INSPECTIONS OF A PERMITTED JOB, AND THE FIRST TIME PASS RATE
 *
 * A permit is a compliance document filed against a job. The authority's
 * visits under it are recorded against it, each pass or fail, a fail saying
 * whose work it was about. The electrical pack's first time inspection pass
 * rate reads them, and is checked here against a month worked out by hand and
 * against core's `inspectionPass` on the same rows.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("permit-inspections:org");
const USER = fixtureId("permit-inspections:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const as = (role: string, extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"], ...extra }, db: db(),
});

let customerId = "";
let propertyId = "";
let jobNumber = 0;

async function jobNamed(summary: string): Promise<string> {
  jobNumber += 1;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, ${summary}, ${`t-${jobNumber}`}, 'technician_dispatch', 'install'::job_revenue_class) returning id`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${jobNumber}, ${customerId}, ${propertyId}, ${type!.id}, 'in_progress', ${summary})
    returning id`;
  return job!.id;
}

/** A permit filed against a job, through the compliance register as the office files one. */
async function permitOn(jobId: string, reference: string, issuedOn = "2026-05-01"): Promise<string> {
  const doc = await compliance.register(owner(), {
    kind: "permit", name: `Electrical permit ${reference}`, reference, issuerName: "City of Austin",
    subjectType: "job", subjectId: jobId, issuedOn, expiresOn: "2027-05-01",
  });
  return doc.id;
}

const passed = (permitId: string, inspectedOn: string, stage = "Final") =>
  permits.record(owner(), { permitId, inspectedOn, stage, result: "passed" });
const failed = (permitId: string, inspectedOn: string, failureScope: "our_work" | "outside_our_work", findings = "Corrections listed") =>
  permits.record(owner(), { permitId, inspectedOn, stage: "Rough in", result: "failed", failureScope, findings });

const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await raw?.end();
});

beforeEach(async () => {
  if (!url) return;
  jobNumber = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Permit Co", slug: "permit-inspections-co" });
  await raw`update public.organization set primary_trade = 'electrical', timezone = 'America/Chicago' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Oak Street', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

run("recording the authority's inspections", () => {
  it("lists a job's permits with each inspection in order, and where the job stands", async () => {
    const job = await jobNamed("Panel change");
    const permit = await permitOn(job, "BP-1");
    await failed(permit, "2026-06-03", "our_work", "Missing bonding jumper at the water line");
    await passed(permit, "2026-06-10");

    const listed = await permits.forJob(owner(), { id: job });
    expect(listed.permits).toHaveLength(1);
    expect(listed.permits[0]!.reference).toBe("BP-1");
    expect(listed.permits[0]!.inspections.map((i) => [i.inspectedOn, i.result, i.failureScope])).toEqual([
      ["2026-06-03", "failed", "our_work"],
      ["2026-06-10", "passed", null],
    ]);
    expect(listed.permits[0]!.inspections[0]!.findings).toBe("Missing bonding jumper at the water line");
    expect(listed.verdict).toBe("failed");
  });

  it("refuses a fail that does not say whose work it was, or what was found", async () => {
    const permit = await permitOn(await jobNamed("Service upgrade"), "BP-2");
    await expect(permits.record(owner(), { permitId: permit, inspectedOn: "2026-06-03", result: "failed", findings: "No GFCI" }))
      .rejects.toThrow(/whose work/);
    await expect(permits.record(owner(), { permitId: permit, inspectedOn: "2026-06-03", result: "failed", failureScope: "our_work" }))
      .rejects.toThrow(/what the inspector found/);
    await expect(permits.record(owner(), { permitId: permit, inspectedOn: "2026-06-03", result: "passed", failureScope: "our_work" }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a day still to come, and one before the permit was issued", async () => {
    const permit = await permitOn(await jobNamed("EV charger"), "BP-3", "2026-06-05");
    await expect(passed(permit, "2099-01-01")).rejects.toThrow(/has not happened yet/);
    await expect(passed(permit, "2026-06-01")).rejects.toThrow(/was issued on 2026-06-05/);
  });

  it("refuses a document that is not a permit, or a permit on no job", async () => {
    const licence = await compliance.register(owner(), { kind: "licence", name: "Master electrician licence" });
    await expect(passed(licence.id, "2026-06-03")).rejects.toThrow(/not a permit/);
    const loose = await compliance.register(owner(), { kind: "permit", name: "Annual permit" });
    await expect(passed(loose.id, "2026-06-03")).rejects.toThrow(/not filed against a job/);
  });

  it("records once however many times the same request is replayed", async () => {
    const job = await jobNamed("Rewire");
    const permit = await permitOn(job, "BP-4");
    const first = await permits.record(owner("permit-replay"), { permitId: permit, inspectedOn: "2026-06-03", result: "passed" });
    const again = await permits.record(owner("permit-replay"), { permitId: permit, inspectedOn: "2026-06-03", result: "passed" });
    expect(again.id).toBe(first.id);
    expect((await permits.forJob(owner(), { id: job })).permits[0]!.inspections).toHaveLength(1);
  });

  it("takes one off, keeps what it said in the audit log, and says so when it is already gone", async () => {
    const job = await jobNamed("Generator");
    const permit = await permitOn(job, "BP-5");
    const wrong = await failed(permit, "2026-06-03", "outside_our_work", "Gas line not tagged");
    expect(await permits.remove(owner(), { id: wrong.id })).toEqual({ removed: true });
    expect(await permits.remove(owner(), { id: wrong.id })).toEqual({ removed: false });
    expect((await permits.forJob(owner(), { id: job })).verdict).toBeNull();
    const [logged] = await raw<{ before: { findings: string } }[]>`
      select before from public.audit_log where organization_id = ${ORG} and action = 'permit_inspection.removed'`;
    expect(logged!.before.findings).toBe("Gas line not tagged");
  });

  it("is the office's to record, and a job somebody may not see is not found", async () => {
    const job = await jobNamed("Lighting");
    const permit = await permitOn(job, "BP-6");
    /** A technician reads jobs and does not write them. */
    await expect(permits.record(as("technician", { technicianId: fixtureId("permit-inspections:nobody") }), {
      permitId: permit, inspectedOn: "2026-06-03", result: "passed",
    })).rejects.toBeInstanceOf(PermissionError);
    /** And one not sent to this job does not see it. */
    await expect(permits.forJob(as("technician", { technicianId: fixtureId("permit-inspections:nobody") }), { id: job }))
      .rejects.toBeInstanceOf(NotFoundError);
    /** Reading the permits needs the documents permission as well as the job. */
    await expect(permits.forJob({
      actor: { userId: USER, organizationId: ORG, roles: [] as unknown as Actor["roles"], grants: ["job:read"] as NonNullable<Actor["grants"]> },
      db: db(),
    }, { id: job })).rejects.toBeInstanceOf(PermissionError);
  });
});

run("the first time inspection pass rate", () => {
  it("counts each permitted job once, on its first inspection, and leaves out a fail outside our work", async () => {
    /**
     * Worked by hand, for June 2026.
     *
     *   A  final passed on Jun 3                                   passed
     *   B  rough in failed for our work Jun 4, passed Jun 11       failed
     *   C  rough in failed for the framer Jun 5, passed Jun 12     left out
     *   D  rough in passed Jun 6, final failed for our work Jul 2  failed (June's job)
     *   E  failed for the HVAC trade Jun 7, then for our work
     *      Jun 14                                                  failed
     *   F  rough in and final both passed, Jun 8 and Jun 20        passed
     *   G  first inspected May 29 (failed for our work), passed
     *      Jun 2                                                   May's job, not June's
     *   H  a permit on file, never inspected                       not a job inspected
     *   I  two permits, both passed Jun 9                          passed, once
     *
     * Signed off first time A, F, I = 3. Inspected A, B, D, E, F, I = 6
     * (C left out, G is May's, H never inspected). 3 / 6 = 50.0%, with one
     * job counted beside it.
     */
    const ids: Record<string, string> = {};
    for (const name of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) ids[name] = await jobNamed(`Job ${name}`);
    const p = async (name: string, ref = name) => permitOn(ids[name]!, `BP-${ref}`);

    await passed(await p("A"), "2026-06-03");
    const b = await p("B");
    await failed(b, "2026-06-04", "our_work");
    await passed(b, "2026-06-11");
    const c = await p("C");
    await failed(c, "2026-06-05", "outside_our_work");
    await passed(c, "2026-06-12");
    const d = await p("D");
    await passed(d, "2026-06-06", "Rough in");
    /** Recorded after the month ended: a later failure on a June job is June's. */
    await raw`
      insert into public.permit_inspection (organization_id, permit_id, job_id, inspected_on, stage, result, failure_scope, findings)
      values (${ORG}, ${d}, ${ids.D!}, '2026-07-02', 'Final', 'failed', 'our_work', 'Breaker not listed for the panel')`;
    const e = await p("E");
    await failed(e, "2026-06-07", "outside_our_work");
    await failed(e, "2026-06-14", "our_work");
    const f = await p("F");
    await passed(f, "2026-06-08", "Rough in");
    await passed(f, "2026-06-20", "Final");
    const g = await p("G");
    await failed(g, "2026-05-29", "our_work");
    await passed(g, "2026-06-02");
    await p("H");
    await passed(await p("I", "I1"), "2026-06-09");
    await passed(await p("I", "I2"), "2026-06-09");

    const card = await kpis.scorecard(owner(), WINDOW);
    const rate = card.computed.find((k) => k.key === "inspection_pass")!;
    expect(rate.numerator).toBe("3");
    expect(rate.denominator).toBe("6");
    expect(rate.value).toBe("50.0");
    expect(rate.besides).toEqual([expect.objectContaining({ key: "excluded", count: "1" })]);

    /** The same rows through core's rule give the same jobs in every half. */
    const rows = await raw<{ job_id: string; inspected_on: string; result: "passed" | "failed"; failure_scope: "our_work" | "outside_our_work" | null }[]>`
      select job_id, inspected_on::text, result::text as result, failure_scope::text as failure_scope
      from public.permit_inspection where organization_id = ${ORG}`;
    const rule = reporting.inspectionPass(rows.map((r) => ({
      jobId: r.job_id, inspectedOn: r.inspected_on, result: r.result, failureScope: r.failure_scope,
    })), WINDOW);
    const drilled = async (half: "numerator" | "denominator" | "excluded") =>
      (await kpis.drill(owner(), { key: "inspection_pass", half, ...WINDOW })).records.map((r) => r.id).sort();
    expect(await drilled("numerator")).toEqual([...rule.passed].sort());
    expect(await drilled("denominator")).toEqual([...rule.passed, ...rule.failed].sort());
    expect(await drilled("excluded")).toEqual([...rule.excluded].sort());
    expect(await drilled("numerator")).toEqual([ids.A!, ids.F!, ids.I!].sort());
    expect(await drilled("excluded")).toEqual([ids.C!]);

    /** Each record opens on its job, dated by its first inspection. */
    const records = await kpis.drill(owner(), { key: "inspection_pass", half: "denominator", ...WINDOW });
    const onD = records.records.find((r) => r.id === ids.D)!;
    expect(onD).toEqual(expect.objectContaining({ kind: "job", onDay: "2026-06-06", href: `/jobs/${ids.D}`, value: "1" }));
  });

  it("is nothing rather than a rate when no permitted job was inspected", async () => {
    await permitOn(await jobNamed("Not yet"), "BP-0");
    const card = await kpis.scorecard(owner(), WINDOW);
    const rate = card.computed.find((k) => k.key === "inspection_pass")!;
    expect(rate.denominator).toBe("0");
    expect(rate.value).toBeNull();
  });

  it("leaves out a job that was deleted", async () => {
    const job = await jobNamed("Deleted");
    await passed(await permitOn(job, "BP-D"), "2026-06-03");
    await raw`update public.job set deleted_at = now() where id = ${job}`;
    const card = await kpis.scorecard(owner(), WINDOW);
    expect(card.computed.find((k) => k.key === "inspection_pass")!.denominator).toBe("0");
  });
});
