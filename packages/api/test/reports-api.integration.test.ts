import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import type { ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { routes, type RouteName } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * REPORTS AND DASHBOARDS OVER THE API (M21)
 *
 * The screens could run a report, save one and assemble a dashboard; the API
 * could only drill. These drive the new routes through the real dispatcher,
 * as an owner, a dispatcher (no money), a branch manager (one branch) and a
 * technician (no reports at all), and check each answer against the schema
 * the SDK is generated from.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rapi:org");
const OWNER = fixtureId("rapi:owner");
const DISPATCHER = fixtureId("rapi:dispatcher");
const HANA = fixtureId("rapi:hana");
const TECH = fixtureId("rapi:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles, ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const dispatcher = () => as(DISPATCHER, ["dispatcher"]);
let austin = "";
let houston = "";
const houstonManager = () => as(HANA, ["branch_manager"], { businessUnitId: houston });
const technician = () => as(TECH, ["technician"]);

async function person(userId: string, email: string, role: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${email})`;
  await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}::public.member_role)`;
}

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

/** The answer, parsed with the schema the SDK was generated from. */
function shaped(name: RouteName, body: unknown) {
  return (routes[name].output as { parse: (v: unknown) => unknown }).parse(body);
}

const JOB_COUNT = { dataset: "jobs", dimensions: [], measures: ["count"] };
const countOf = (body: Record<string, unknown>) =>
  Number(((body["rows"] as Record<string, unknown>[])[0] ?? {})["count"] ?? 0);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Reports API Co", slug: "reports-api-co" });
  await person(DISPATCHER, "rapi-dispatcher@test.local", "dispatcher");
  await person(HANA, "rapi-hana@test.local", "office_manager");
  await person(TECH, "rapi-tech@test.local", "technician");

  austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "AUS" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;

  const customer = (await customers.create(owner(), {
    type: "residential", name: "Report Reader", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const place = (await properties.create(owner(), {
    address: { line1: "1 Report St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer, customerRole: "owner",
  })).id as string;
  const job = (summary: string, businessUnitId: string) => jobs.create(owner(), {
    customerId: customer, propertyId: place, summary, tags: [], customFields: {}, businessUnitId,
  });
  await job("Austin one", austin);
  await job("Austin two", austin);
  await job("Houston one", houston);
});

afterAll(async () => { if (raw) await raw.end(); });

run("running reports over the API", () => {
  it("lists the reports each person may run, and refuses a person with no reports", async () => {
    const mine = await call("GET", "/v1/reports", owner());
    expect(mine.status).toBe(200);
    shaped("listReports", mine.body);
    const slugs = (mine.body["builtIn"] as { slug: string }[]).map((r) => r.slug);
    expect(slugs).toEqual(expect.arrayContaining(["jobs-by-status", "revenue-by-month"]));

    // No money for the dispatcher: the revenue report is not offered.
    const theirs = await call("GET", "/v1/reports", dispatcher());
    const theirSlugs = (theirs.body["builtIn"] as { slug: string }[]).map((r) => r.slug);
    expect(theirSlugs).toContain("jobs-by-status");
    expect(theirSlugs).not.toContain("revenue-by-month");

    const catalogue = await call("GET", "/v1/reports/catalogue", dispatcher());
    expect(catalogue.status).toBe(200);
    shaped("getReportCatalogue", catalogue.body);
    const datasets = (catalogue.body["datasets"] as { key: string }[]).map((d) => d.key);
    expect(datasets).toContain("jobs");
    expect(datasets).not.toContain("invoices");

    for (const [method, path, body] of [
      ["GET", "/v1/reports", undefined],
      ["GET", "/v1/reports/catalogue", undefined],
      ["POST", "/v1/reports/run", { definition: JOB_COUNT }],
      ["GET", "/v1/dashboards", undefined],
      ["GET", "/v1/dashboards/built-in/operations", undefined],
    ] as const) {
      expect((await call(method, path, technician(), body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("runs a report inside the caller's own scope, and a branch only narrows it", async () => {
    const all = await call("POST", "/v1/reports/run", owner(), { definition: JOB_COUNT });
    expect(all.status).toBe(201);
    shaped("runReport", all.body);
    expect(countOf(all.body)).toBe(3);

    const austinOnly = await call("POST", "/v1/reports/run", owner(), { definition: { ...JOB_COUNT, branchId: austin } });
    expect(countOf(austinOnly.body)).toBe(2);

    // The Houston manager sees Houston, and naming Austin does not widen it.
    expect(countOf((await call("POST", "/v1/reports/run", houstonManager(), { definition: JOB_COUNT })).body)).toBe(1);
    expect(countOf((await call("POST", "/v1/reports/run", houstonManager(), {
      definition: { ...JOB_COUNT, branchId: austin },
    })).body)).toBe(0);

    // A report on money is refused to the dispatcher, in words.
    const money = await call("POST", "/v1/reports/run", dispatcher(), {
      definition: { dataset: "invoices", dimensions: [], measures: ["count"] },
    });
    expect(money.status).toBe(409);
  });

  it("the drill takes the branch its definition names", async () => {
    const drilled = await call("POST", "/v1/reports/drill", owner(), {
      definition: { ...JOB_COUNT, branchId: houston }, match: {},
    });
    expect(drilled.status).toBe(201);
    expect(drilled.body["count"]).toBe(1);
  });

  it("saves, changes, runs and deletes a report, with an audit row for each change", async () => {
    // Saving needs report:build, which a dispatcher does not hold.
    expect((await call("POST", "/v1/reports", dispatcher(), { name: "Nope", definition: JOB_COUNT })).status).toBe(403);

    const created = await call("POST", "/v1/reports", owner(), {
      name: "Every job", description: "All of them", definition: JOB_COUNT,
    });
    expect(created.status).toBe(201);
    shaped("createReport", created.body);
    const id = created.body["id"] as string;

    // A second save with the name is refused rather than saved twice.
    expect((await call("POST", "/v1/reports", owner(), { name: "Every job", definition: JOB_COUNT })).status).toBe(409);

    // A retry with the first one's key is answered with what the first one saved.
    const key = `rapi-report-${Date.now()}`;
    const once = await call("POST", "/v1/reports", owner(), { name: "Saved once", definition: JOB_COUNT }, key);
    const twice = await call("POST", "/v1/reports", owner(), { name: "Saved once", definition: JOB_COUNT }, key);
    expect(once.status).toBe(201);
    expect(twice.status).toBe(201);
    expect(twice.body["id"]).toBe(once.body["id"]);

    const changed = await call("PATCH", `/v1/reports/${id}`, owner(), { name: "Every job we have", definition: JOB_COUNT });
    expect(changed.status).toBe(200);
    expect(changed.body["name"]).toBe("Every job we have");
    expect((await call("PATCH", `/v1/reports/${id}`, dispatcher(), { name: "Mine", definition: JOB_COUNT })).status).toBe(403);

    // Checked against whoever runs it: the owner's saved report is one job for Houston.
    const theirs = await call("POST", `/v1/reports/${id}/run`, houstonManager(), {});
    expect(theirs.status).toBe(201);
    shaped("runSavedReport", theirs.body);
    expect(countOf(theirs.body["result"] as Record<string, unknown>)).toBe(3 - 2);
    const ownersAustin = await call("POST", `/v1/reports/${id}/run`, owner(), { branchId: austin });
    expect(countOf(ownersAustin.body["result"] as Record<string, unknown>)).toBe(2);
    const later = await call("POST", `/v1/reports/${id}/run`, owner(), { from: companyToday(30) });
    expect(countOf(later.body["result"] as Record<string, unknown>)).toBe(0);

    const listed = await call("GET", "/v1/reports", dispatcher());
    expect((listed.body["saved"] as { id: string }[]).map((r) => r.id)).toContain(id);

    expect((await call("DELETE", `/v1/reports/${id}`, dispatcher())).status).toBe(403);
    const gone = await call("DELETE", `/v1/reports/${id}`, owner());
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ ok: true });
    expect((await call("POST", `/v1/reports/${id}/run`, owner(), {})).status).toBe(404);

    const trail = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${id} order by created_at`;
    expect(trail.map((row) => row.action)).toEqual(["report.created", "report.updated", "report.deleted"]);
  });
});

run("dashboards over the API", () => {
  it("lists and draws the dashboards that ship, as each person may see them", async () => {
    const mine = await call("GET", "/v1/dashboards", owner());
    expect(mine.status).toBe(200);
    shaped("listDashboards", mine.body);
    expect((mine.body["builtIn"] as { slug: string }[]).map((d) => d.slug)).toEqual(expect.arrayContaining(["operations", "money"]));

    const theirs = await call("GET", "/v1/dashboards", dispatcher());
    const theirSlugs = (theirs.body["builtIn"] as { slug: string }[]).map((d) => d.slug);
    expect(theirSlugs).toContain("operations");
    expect(theirSlugs).not.toContain("money");

    const operations = await call("GET", "/v1/dashboards/built-in/operations", dispatcher());
    expect(operations.status).toBe(200);
    shaped("getBuiltInDashboard", operations.body);
    expect((operations.body["tiles"] as unknown[]).length).toBeGreaterThan(0);
    // Every tile on the money dashboard is money, so for the dispatcher it is not there.
    expect((await call("GET", "/v1/dashboards/built-in/money", dispatcher())).status).toBe(404);
  });

  it("assembles, draws, changes and deletes a dashboard, with an audit row for each change", async () => {
    const report = await call("POST", "/v1/reports", owner(), { name: "Jobs, one number", definition: JOB_COUNT });
    const reportId = report.body["id"] as string;

    expect((await call("POST", "/v1/dashboards", dispatcher(), { name: "Nope" })).status).toBe(403);
    const created = await call("POST", "/v1/dashboards", owner(), { name: "Front desk", description: "The morning look" });
    expect(created.status).toBe(201);
    shaped("createDashboard", created.body);
    const id = created.body["id"] as string;
    expect(created.body["tiles"]).toEqual([]);

    const key = `rapi-dashboard-${Date.now()}`;
    const once = await call("POST", "/v1/dashboards", owner(), { name: "Made once" }, key);
    const twice = await call("POST", "/v1/dashboards", owner(), { name: "Made once" }, key);
    expect(twice.status).toBe(201);
    expect(twice.body["id"]).toBe(once.body["id"]);

    const tiles = [
      { key: "jobs", kind: "number", width: 3, reportId, title: "Jobs" },
      { key: "status", kind: "bars", width: 6, builtIn: "jobs-by-status" },
    ];
    expect((await call("PUT", `/v1/dashboards/${id}/tiles`, dispatcher(), { tiles })).status).toBe(403);
    const set = await call("PUT", `/v1/dashboards/${id}/tiles`, owner(), { tiles });
    expect(set.status).toBe(200);
    shaped("setDashboardTiles", set.body);
    expect((set.body["tiles"] as { key: string }[]).map((t) => t.key)).toEqual(["jobs", "status"]);

    // A tile pointing at nothing is refused at save.
    const broken = await call("PUT", `/v1/dashboards/${id}/tiles`, owner(), {
      tiles: [{ key: "x", kind: "number", width: 3, reportId: fixtureId("rapi:no-such-report") }],
    });
    expect(broken.status).toBe(409);

    // Drawn for the person reading it: three jobs for the owner, Houston's one for its manager.
    const drawn = await call("GET", `/v1/dashboards/${id}`, owner());
    expect(drawn.status).toBe(200);
    shaped("getDashboard", drawn.body);
    const tileOf = (body: Record<string, unknown>, key: string) =>
      (body["tiles"] as { key: string; result?: Record<string, unknown> }[]).find((t) => t.key === key)!;
    expect(countOf(tileOf(drawn.body, "jobs").result!)).toBe(3);
    expect((drawn.body["stored"] as { key: string }[]).map((t) => t.key)).toEqual(["jobs", "status"]);
    const hers = await call("GET", `/v1/dashboards/${id}`, houstonManager());
    expect(countOf(tileOf(hers.body, "jobs").result!)).toBe(1);
    expect((await call("GET", `/v1/dashboards/${id}`, technician())).status).toBe(403);

    expect((await call("DELETE", `/v1/dashboards/${id}`, dispatcher())).status).toBe(403);
    expect((await call("DELETE", `/v1/dashboards/${id}`, owner())).status).toBe(200);
    expect((await call("GET", `/v1/dashboards/${id}`, owner())).status).toBe(404);

    const trail = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${id} order by created_at`;
    expect(trail.map((row) => row.action)).toEqual(["dashboard.created", "dashboard.updated", "dashboard.deleted"]);
  });
});
