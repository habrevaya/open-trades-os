import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as commercial from "../src/services/commercial";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import type { ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { routes } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A JOB'S CEILING OVER THE API (M31)
 *
 * The not to exceed limit was set and read only from the job's page. These
 * drive `GET` and `PUT /v1/jobs/{id}/authorization` through the dispatcher:
 * a first authorisation, invoices billed against it, a supplement that keeps
 * what was billed, a retry that records nothing new, and the refusals: no
 * permission, another branch's job, a party from another job, a ceiling less
 * than nothing.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("jauth:org");
const OWNER = fixtureId("jauth:owner");
const HANA = fixtureId("jauth:hana");
const TECH = fixtureId("jauth:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles, ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
let austin = "";
let houston = "";
const houstonManager = () => as(HANA, ["branch_manager"], { businessUnitId: houston });
const technician = () => as(TECH, ["technician"]);
const nobody = () => as(TECH, [] as unknown as Actor["roles"]);

let customerId = "";
let austinJob = "";
let otherJob = "";

async function call(
  method: string, path: string, ctx: ServiceContext, body?: unknown, key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await dispatch(new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { db: db(), resolveSession: async () => ctx });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

type Current = { id: string; amount: string | null; consumed: string; remaining: string | null; grantedByName: string | null };
type History = { id: string; state: string; amount: string | null; supersedesId: string | null; scopeNotes: string | null }[];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Ceiling API Co", slug: "job-authorization-api-co" });
  for (const [id, email, role] of [[HANA, "jauth-hana@test.local", "office_manager"], [TECH, "jauth-tech@test.local", "technician"]] as const) {
    await raw`delete from public."user" where id = ${id} or email = ${email}`;
    await raw`insert into public."user" (id, email) values (${id}, ${email})`;
    await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::public.member_role)`;
  }
  austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "AUS" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;

  customerId = (await customers.create(owner(), {
    type: "commercial", name: "Northgate Facilities", paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const propertyId = (await properties.create(owner(), {
    address: { line1: "9 Ceiling Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  const job = async (summary: string, businessUnitId: string) => (await jobs.create(owner(), {
    customerId, propertyId, summary, tags: [], customFields: {}, businessUnitId,
  })).id as string;
  austinJob = await job("Rooftop unit", austin);
  otherJob = await job("Walk in cooler", austin);
});

afterAll(async () => { if (raw) await raw.end(); });

run("a job's authorisation over the API", () => {
  it("starts with none, so the job bills what it costs", async () => {
    const empty = await call("GET", `/v1/jobs/${austinJob}/authorization`, owner());
    expect(empty.status).toBe(200);
    routes.getJobAuthorization.output.parse(empty.body);
    expect(empty.body).toEqual({ current: null, history: [] });
  });

  it("records a ceiling, keeps what was billed across a supplement, and answers a retry with the first answer", async () => {
    const first = await call("PUT", `/v1/jobs/${austinJob}/authorization`, owner(), {
      amount: "500.00", grantedByName: "Northgate AP, Dana", externalReference: "NTE 44812",
    });
    expect(first.status).toBe(200);
    routes.setJobAuthorization.output.parse(first.body);
    const granted = first.body["current"] as Current;
    expect(granted).toMatchObject({ amount: "500.0000", consumed: "0.0000", remaining: "500.0000", grantedByName: "Northgate AP, Dana" });

    // Three hundred billed against it, by the invoice that consumes it.
    await billing.create(owner(), {
      customerId, jobId: austinJob,
      lines: [{ name: "Diagnosis", quantity: "1", unitPrice: "300.00", discountAmount: "0", taxable: false }],
    });

    const key = `jauth-supplement-${Date.now()}`;
    const supplement = { amount: "1000.00", grantedByName: "Northgate AP, Dana", scopeNotes: "Compressor approved" };
    const raised = await call("PUT", `/v1/jobs/${austinJob}/authorization`, owner(), supplement, key);
    expect(raised.status).toBe(200);
    const now = raised.body["current"] as Current;
    expect(now).toMatchObject({ amount: "1000.0000", consumed: "300.0000", remaining: "700.0000" });
    const history = raised.body["history"] as History;
    expect(history.map((h) => h.state)).toEqual(["granted", "superseded"]);
    expect(history[0]).toMatchObject({ id: now.id, supersedesId: granted.id, scopeNotes: "Compressor approved" });

    // The same request again: the same supplement, not a third row.
    const again = await call("PUT", `/v1/jobs/${austinJob}/authorization`, owner(), supplement, key);
    expect(again.status).toBe(200);
    expect((again.body["current"] as Current).id).toBe(now.id);
    expect((again.body["history"] as History)).toHaveLength(2);

    const read = await call("GET", `/v1/jobs/${austinJob}/authorization`, owner());
    expect((read.body["current"] as Current).remaining).toBe("700.0000");

    const trail = await raw<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
      where organization_id = ${ORG} and entity_id = ${austinJob} and action = 'authorization.granted'`;
    expect(trail[0]!.count).toBe(2);
  });

  it("takes no limit as a real answer", async () => {
    const open = await call("PUT", `/v1/jobs/${otherJob}/authorization`, owner(), { amount: null, grantedByName: "Northgate AP" });
    expect(open.status).toBe(200);
    expect(open.body["current"]).toMatchObject({ amount: null, remaining: null });
  });

  it("refuses a ceiling less than nothing, and a party from another job", async () => {
    expect((await call("PUT", `/v1/jobs/${otherJob}/authorization`, owner(), { amount: "-5.00" })).status).toBe(409);

    const [party] = await commercial.setParties(owner(), {
      jobId: austinJob, parties: [{ role: "approver", externalName: "Northgate AP" }],
    });
    const elsewhere = await call("PUT", `/v1/jobs/${otherJob}/authorization`, owner(), {
      amount: "200.00", grantedByPartyId: party!.id,
    });
    expect(elsewhere.status).toBe(409);
    const own = await call("PUT", `/v1/jobs/${austinJob}/authorization`, owner(), {
      amount: "1000.00", grantedByPartyId: party!.id,
    });
    expect(own.status).toBe(200);
    expect((own.body["history"] as { grantedByPartyId: string | null }[])[0]!.grantedByPartyId).toBe(party!.id);
  });

  it("is refused without the permission, and another branch's job is not found", async () => {
    // A technician reads the job and may not set its ceiling; somebody with no access reads nothing.
    expect((await call("PUT", `/v1/jobs/${austinJob}/authorization`, technician(), { amount: "1.00" })).status).toBe(403);
    expect((await call("GET", `/v1/jobs/${austinJob}/authorization`, nobody())).status).toBe(403);

    expect((await call("GET", `/v1/jobs/${austinJob}/authorization`, houstonManager())).status).toBe(404);
    expect((await call("PUT", `/v1/jobs/${austinJob}/authorization`, houstonManager(), { amount: "9999.00" })).status).toBe(404);
  });
});
