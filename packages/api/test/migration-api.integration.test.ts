import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { routes, type RouteName } from "../src/contracts/index";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A MIGRATION, THROUGH THE FRONT DOOR
 *
 * The migration toolkit loads a company's history through `/api/v1` with a
 * connected app's token and nothing else, so this drives the same routes
 * through the real dispatcher as an app would: an actor with no roles and an
 * explicit grant list, every response parsed with the schema the OpenAPI
 * document and the SDK are generated from.
 *
 * Each block is one of the gaps the toolkit documented, closed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("migration-api:org");
const USER = fixtureId("migration-api:user");

let raw: postgres.Sql;

/** What an owner would grant a migration's app token. */
const IMPORTER = [
  "customer:read", "customer:write", "property:read", "property:write",
  "pricebook:read", "pricebook:write", "job:read", "job:write", "job:complete",
  "visit:read", "visit:write", "estimate:read", "estimate:write",
  "invoice:read", "invoice:write", "payment:read", "payment:collect", "payment:refund",
  "user:read", "data:import",
];

const app = (grants: string[] = IMPORTER): ServiceContext => ({
  actor: {
    userId: "00000000-0000-0000-0000-000000000000", organizationId: ORG, roles: [] as Actor["roles"],
    grants: grants as NonNullable<Actor["grants"]>, agentId: "app:migration-test",
    // An app reads what its install granted it, and a migration reads the
    // whole company. Without this every scoped list answers with nothing.
    scopes: { customer: "all", job: "all", estimate: "all", invoice: "all" },
  },
  db: testDb(url!),
});

interface Called { status: number; body: Record<string, unknown> }

/**
 * One call through the dispatcher. A success is parsed with the route's
 * published output schema, so a field promised and not produced fails here
 * rather than in somebody's generated client.
 */
async function call(
  name: RouteName,
  input: Record<string, unknown> = {},
  opts: { ctx?: ServiceContext; key?: string } = {},
): Promise<Called> {
  const route = routes[name] as { method: string; path: string; output: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } };
  let path = route.path;
  const rest = { ...input };
  for (const match of route.path.matchAll(/\{(\w+)\}/g)) {
    path = path.replace(match[0], encodeURIComponent(String(rest[match[1]!])));
    delete rest[match[1]!];
  }
  const isRead = route.method === "get";
  const query = isRead
    ? "?" + new URLSearchParams(Object.entries(rest).map(([k, v]): [string, string] => [k, String(v)])).toString()
    : "";
  const response = await dispatch(
    new Request(`http://localhost${path}${query}`, {
      method: route.method.toUpperCase(),
      headers: {
        ...(isRead ? {} : { "content-type": "application/json" }),
        ...(opts.key ? { "idempotency-key": opts.key } : {}),
      },
      ...(isRead ? {} : { body: JSON.stringify(rest) }),
    }),
    { db: testDb(url!), resolveSession: async () => opts.ctx ?? app() },
  );
  const body = await response.json() as Record<string, unknown>;
  if (response.status < 300) {
    const parsed = route.output.safeParse(body);
    expect(parsed.success, `${name}: ${JSON.stringify(parsed.error)}`).toBe(true);
  }
  return { status: response.status, body };
}

const ok = async (name: RouteName, input: Record<string, unknown> = {}, opts = {}) => {
  const result = await call(name, input, opts);
  expect([200, 201], `${name}: ${JSON.stringify(result.body)}`).toContain(result.status);
  return result.body as Record<string, unknown> & { id: string };
};

const address = { line1: "12 Source St", city: "Austin", state: "TX", postalCode: "78701", country: "US" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Migration Co", slug: "migration-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

run("provenance on every create", () => {
  it("stores where each record came from, returns it, and finds it again", async () => {
    const ref = (id: string) => ({ source: "jobber", id });
    const customer = await ok("createCustomer", { name: "Jo Jobber", externalRef: ref("C-1") });
    expect(customer.externalRef).toEqual(ref("C-1"));
    const property = await ok("createProperty", { address, customerId: customer.id, externalRef: ref("P-1") });
    const item = await ok("createPriceBookItem", { code: "TUNE", name: "Tune up", price: "99.00", externalRef: ref("I-1") });
    expect(item.externalRef).toEqual(ref("I-1"));
    const job = await ok("createJob", {
      customerId: customer.id, propertyId: property.id, summary: "Imported job", externalRef: ref("J-1"),
      visit: { windowStart: "2026-09-01T15:00:00.000Z", windowEnd: "2026-09-01T17:00:00.000Z", externalRef: ref("V-1") },
    });
    const visit = await ok("scheduleVisit", {
      id: job.id, windowStart: "2026-09-02T15:00:00.000Z", windowEnd: "2026-09-02T17:00:00.000Z", externalRef: ref("V-2"),
    });
    expect(visit.externalRef).toEqual(ref("V-2"));
    const read = await ok("getJob", { id: job.id });
    expect((read.visits as Array<{ externalRef: unknown }>).map((v) => v.externalRef)).toEqual([ref("V-1"), ref("V-2")]);

    const estimate = await ok("createEstimate", {
      customerId: customer.id, propertyId: property.id, externalRef: ref("E-1"),
      options: [{ name: "Only", lines: [{ name: "Work", unitPrice: "10.00" }] }],
    });
    expect(estimate.externalRef).toEqual(ref("E-1"));
    const invoice = await ok("createInvoice", {
      customerId: customer.id, externalRef: ref("INV-1"), lines: [{ name: "Work", unitPrice: "10.00" }],
    });
    expect(invoice.externalRef).toEqual(ref("INV-1"));
    await ok("recordPayment", {
      customerId: customer.id, method: "check", amount: "10.00", externalRef: ref("PAY-1"),
      allocations: [{ invoiceId: invoice.id, amount: "10.00" }],
    });

    const lookups: Array<[RouteName, string, string]> = [
      ["listCustomers", "C-1", customer.id], ["listProperties", "P-1", property.id],
      ["listPriceBook", "I-1", item.id], ["listJobs", "J-1", job.id],
      ["listEstimates", "E-1", estimate.id], ["listInvoices", "INV-1", invoice.id],
    ];
    for (const [route, id, expected] of lookups) {
      const page = await ok(route, { externalSource: "jobber", externalId: id });
      const data = page.data as Array<{ id: string; externalRef: unknown }>;
      expect(data.map((d) => d.id), route).toEqual([expected]);
      expect(data[0]!.externalRef, route).toEqual(ref(id));
    }
  });

  it("refuses a second record for the same source record, naming the first", async () => {
    const first = await ok("createCustomer", { name: "Once", externalRef: { source: "hcp", id: "dup" } });
    const second = await call("createCustomer", { name: "Twice", externalRef: { source: "hcp", id: "dup" } });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain(first.id);
    // Another system's id 'dup' is a different record.
    await ok("createCustomer", { name: "Elsewhere", externalRef: { source: "jobber", id: "dup" } });
  });

  it("does not let a caller claim a source this product writes itself", async () => {
    const result = await call("createCustomer", { name: "Sneaky", externalRef: { source: "recurring_schedule", id: "x" } });
    expect(result.status).toBe(422);
  });
});

run("the source document's own number", () => {
  it("keeps it, refuses it when taken, and numbers the next new one past it", async () => {
    const customer = await ok("createCustomer", { name: "Numbered" });
    const property = await ok("createProperty", { address, customerId: customer.id });

    const imported = await ok("createInvoice", { customerId: customer.id, number: 2201, lines: [{ name: "Old", unitPrice: "5.00" }] });
    expect(imported.number).toBe(2201);
    const clash = await call("createInvoice", { customerId: customer.id, number: 2201, lines: [{ name: "Old", unitPrice: "5.00" }] });
    expect(clash.status).toBe(409);
    const next = await ok("createInvoice", { customerId: customer.id, lines: [{ name: "New", unitPrice: "5.00" }] });
    expect(next.number).toBe(2202);

    const job = await ok("createJob", { customerId: customer.id, propertyId: property.id, summary: "Old job", number: 9001 });
    expect(job.number).toBe(9001);
    const estimate = await ok("createEstimate", {
      customerId: customer.id, propertyId: property.id, number: 450,
      options: [{ name: "Only", lines: [{ name: "Work", unitPrice: "10.00" }] }],
    });
    expect(estimate.number).toBe(450);
  });

  it("is history, so it needs data:import", async () => {
    const customer = await ok("createCustomer", { name: "No import" });
    const refused = await call("createInvoice",
      { customerId: customer.id, number: 77, lines: [{ name: "Old", unitPrice: "5.00" }] },
      { ctx: app(IMPORTER.filter((p) => p !== "data:import")) });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("data:import");
  });
});

run("a job's next visit, on the list", () => {
  it("is the earliest open visit still ahead, not any visit", async () => {
    const customer = await ok("createCustomer", { name: "Next visit" });
    const property = await ok("createProperty", { address, customerId: customer.id });
    const soon = new Date(Date.now() + 2 * 864e5).toISOString();
    const later = new Date(Date.now() + 5 * 864e5).toISOString();
    const job = await ok("createJob", {
      customerId: customer.id, propertyId: property.id, summary: "Two visits",
      visit: { windowStart: later, windowEnd: later },
    });
    await ok("scheduleVisit", { id: job.id, windowStart: soon, windowEnd: soon });
    const page = await ok("listJobs", { customerId: customer.id });
    expect((page.data as Array<{ nextVisitAt: string }>)[0]!.nextVisitAt).toBe(soon);
  });
});
