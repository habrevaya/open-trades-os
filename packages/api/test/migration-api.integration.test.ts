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
  "user:read", "document:read", "document:write", "data:import",
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

run("reading back what a migration needs to map and reconcile", () => {
  it("lists the people, with the technician id a visit names, matchable by email", async () => {
    const [membership] = await raw<{ id: string }[]>`select id from public.membership
      where organization_id = ${ORG} and user_id = ${USER}`;
    await raw`delete from public.technician where organization_id = ${ORG}`;
    const [tech] = await raw<{ id: string }[]>`insert into public.technician
      (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, 'Mo Tech') returning id`;
    // Another company's people are never in the answer.
    const OTHER = fixtureId("migration-api:other-org");
    await seedOrg(raw, { organizationId: OTHER, userId: fixtureId("migration-api:other-user"), name: "Other", slug: "migration-other" });

    const people = await ok("listPeople", {});
    const data = people.people as Array<{ email: string; technicianId: string | null; userId: string; name: string | null }>;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ email: "migration-co@test.local", technicianId: tech!.id, userId: USER });
    const byEmail = await ok("listPeople", { email: "MIGRATION-CO@test.local" });
    expect((byEmail.people as unknown[]).length).toBe(1);
    const nobody = await ok("listPeople", { email: "someone-else@test.local" });
    expect(nobody.people).toEqual([]);
    expect((await call("listPeople", {}, { ctx: app(["job:read"]) })).status).toBe(403);
  });

  it("lists job types", async () => {
    await raw`insert into public.job_type (organization_id, name, code) values (${ORG}, 'Repair', 'REP')`;
    const types = await ok("listJobTypes", {});
    expect((types.data as Array<{ name: string }>).map((t) => t.name)).toContain("Repair");
  });

  it("lists payments with their allocations and what they still hold, by customer, invoice and date", async () => {
    const customer = await ok("createCustomer", { name: "Payer" });
    const invoice = await ok("createInvoice", { customerId: customer.id, lines: [{ name: "Work", unitPrice: "50.00" }] });
    const applied = await ok("recordPayment", {
      customerId: customer.id, method: "check", amount: "50.00", receivedAt: "2024-02-01T15:00:00.000Z",
      allocations: [{ invoiceId: invoice.id, amount: "50.00" }],
    });
    const held = await ok("recordPayment", {
      customerId: customer.id, method: "cash", amount: "30.00", receivedAt: "2024-03-01T15:00:00.000Z", allocations: [],
    });

    const all = await ok("listPayments", { customerId: customer.id });
    expect((all.data as Array<{ id: string }>).map((p) => p.id)).toEqual([held.id, applied.id]);
    const one = (all.data as Array<{ id: string }>).find((p) => p.id === applied.id);
    expect(one).toMatchObject({ allocations: [{ invoiceId: invoice.id, amount: "50.0000" }], unappliedAmount: "0.0000" });
    /** The same request carries the window's totals, which a day's banking is checked against. */
    expect(all.totals).toMatchObject({ gross: "80.0000" });
    expect((all.byMethod as Array<{ method: string }>).map((m) => m.method).sort()).toEqual(["cash", "check"]);

    const byInvoice = await ok("listPayments", { invoiceId: invoice.id });
    expect((byInvoice.data as Array<{ id: string }>).map((p) => p.id)).toEqual([applied.id]);
    const holding = await ok("listPayments", { customerId: customer.id, unappliedOnly: true });
    expect((holding.data as Array<{ id: string }>).map((p) => p.id)).toEqual([held.id]);
    const march = await ok("listPayments", { customerId: customer.id, receivedFrom: "2024-02-15T00:00:00.000Z" });
    expect((march.data as Array<{ id: string }>).map((p) => p.id)).toEqual([held.id]);

    const first = await ok("listPayments", { customerId: customer.id, limit: 1 });
    expect(first.hasMore).toBe(true);
    const second = await ok("listPayments", { customerId: customer.id, limit: 1, cursor: first.nextCursor });
    expect((second.data as Array<{ id: string }>).map((p) => p.id)).toEqual([applied.id]);
  });
});

run("adding a visit, retried", () => {
  it("is a no-op with the same idempotency key, as the contract has always said", async () => {
    const customer = await ok("createCustomer", { name: "Retry" });
    const property = await ok("createProperty", { address, customerId: customer.id });
    const job = await ok("createJob", { customerId: customer.id, propertyId: property.id, summary: "Retried" });
    const body = { id: job.id, windowStart: "2026-11-02T15:00:00.000Z", windowEnd: "2026-11-02T17:00:00.000Z" };
    const first = await ok("scheduleVisit", body, { key: "visit-retry-1" });
    const again = await ok("scheduleVisit", body, { key: "visit-retry-1" });
    expect(again.id).toBe(first.id);
    const read = await ok("getJob", { id: job.id });
    expect((read.visits as unknown[]).length).toBe(1);
    const other = await ok("scheduleVisit", body, { key: "visit-retry-2" });
    expect(other.id).not.toBe(first.id);
  });
});

run("visits that were called off, or never given a time", () => {
  it("records a cancelled visit without dispatching it or holding the job open", async () => {
    const customer = await ok("createCustomer", { name: "Called off" });
    const property = await ok("createProperty", { address, customerId: customer.id });
    const job = await ok("createJob", { customerId: customer.id, propertyId: property.id, summary: "Cancelled once" });
    const cancelled = await ok("scheduleVisit", {
      id: job.id, windowStart: "2024-05-01T15:00:00.000Z", windowEnd: "2024-05-01T17:00:00.000Z", status: "cancelled",
    });
    expect(cancelled.status).toBe("cancelled");
    const done = await ok("scheduleVisit", { id: job.id, windowStart: "2024-05-08T15:00:00.000Z", windowEnd: "2024-05-08T17:00:00.000Z" });
    await ok("completeVisit", { id: done.id, completedOfflineAt: "2024-05-08T16:30:00.000Z" });
    const read = await ok("getJob", { id: job.id });
    // The cancelled visit did not keep the job from completing.
    expect(read.status).toBe("completed");
  });

  it("records a visit with no time as unassigned, and refuses half a window", async () => {
    const customer = await ok("createCustomer", { name: "No time" });
    const property = await ok("createProperty", { address, customerId: customer.id });
    const job = await ok("createJob", { customerId: customer.id, propertyId: property.id, summary: "Untimed" });
    const untimed = await ok("scheduleVisit", { id: job.id });
    expect(untimed).toMatchObject({ status: "unassigned", windowStart: null, windowEnd: null });
    const half = await call("scheduleVisit", { id: job.id, windowStart: "2024-05-01T15:00:00.000Z" });
    expect(half.status).toBe(422);
  });
});

run("a refund paid by hand", () => {
  const ledgerFor = (id: string) => raw<{ account_code: string; direction: string; amount: string; occurred_at: Date }[]>`
    select account_code, direction, amount, occurred_at from public.ledger_entry
    where organization_id = ${ORG} and source_id = ${id} and source_type = 'refund'`;

  it("returns held credit first, then reopens what the payment paid, and says so in the ledger", async () => {
    const customer = await ok("createCustomer", { name: "Refunded" });
    const invoice = await ok("createInvoice", { customerId: customer.id, lines: [{ name: "Work", unitPrice: "60.00" }] });
    const payment = await ok("recordPayment", {
      customerId: customer.id, method: "check", amount: "100.00",
      allocations: [{ invoiceId: invoice.id, amount: "60.00" }],
    });
    expect(payment.unappliedAmount).toBe("40.0000");

    const after = await ok("recordRefund", {
      id: payment.id, amount: "50.00", method: "check", checkNumber: "1043",
      refundedAt: "2024-06-03T15:00:00.000Z", reason: "Overpaid, and part of the job was not done",
    });
    expect(after).toMatchObject({ refundedAmount: "50.0000", status: "partially_refunded", unappliedAmount: "0.0000" });

    const reopened = await ok("getInvoice", { id: invoice.id });
    expect(reopened).toMatchObject({ amountPaid: "50.0000", balance: "10.0000", status: "partially_paid" });

    const entries = await ledgerFor(payment.id);
    expect(entries.map((e) => [e.account_code, e.direction, e.amount]).sort()).toEqual([
      ["1000", "credit", "50.0000"], ["1200", "debit", "10.0000"], ["2300", "debit", "40.0000"],
    ]);
    for (const e of entries) expect(e.occurred_at.toISOString()).toBe("2024-06-03T15:00:00.000Z");

    const over = await call("recordRefund", { id: payment.id, amount: "60.00", method: "check", reason: "Too much" });
    expect(over.status).toBe(409);
  });

  it("is retried safely, and a historical one needs data:import", async () => {
    const customer = await ok("createCustomer", { name: "Refund retry" });
    const payment = await ok("recordPayment", { customerId: customer.id, method: "cash", amount: "20.00", allocations: [] });
    const body = { id: payment.id, amount: "5.00", method: "cash", reason: "Change owed" };
    await ok("recordRefund", body, { key: "refund-retry-1" });
    const again = await ok("recordRefund", body, { key: "refund-retry-1" });
    expect(again.refundedAmount).toBe("5.0000");

    const refused = await call("recordRefund", { ...body, refundedAt: "2023-01-05T15:00:00.000Z" },
      { ctx: app(IMPORTER.filter((p) => p !== "data:import")) });
    expect(refused.status).toBe(403);
  });
});

run("attaching a file without being a phone", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64");

  it("stores the bytes once, attaches them, and lists them on the record", async () => {
    const customer = await ok("createCustomer", { name: "Photos" });
    const property = await ok("createProperty", { address, customerId: customer.id });
    const job = await ok("createJob", { customerId: customer.id, propertyId: property.id, summary: "With photos" });

    const first = await ok("uploadAttachment", {
      entityType: "job", entityId: job.id, fileName: "before.png", contentType: "image/png", bytes: png, phase: "before",
    });
    expect(first).toMatchObject({ kind: "photo", contentType: "image/png", sizeBytes: 16, alreadyHeld: false });
    const again = await ok("uploadAttachment", { entityType: "job", entityId: job.id, fileName: "before.png", bytes: png });
    expect(again).toMatchObject({ id: first.id, alreadyHeld: true });
    // The same bytes on another record are another attachment, and one stored file.
    const onProperty = await ok("uploadAttachment", { entityType: "property", entityId: property.id, fileName: "house.png", bytes: png });
    expect(onProperty.id).not.toBe(first.id);
    expect(onProperty.storageKey).toBe(first.storageKey);

    const listed = await ok("listAttachments", { entityType: "job", entityId: job.id });
    expect((listed.attachments as Array<{ id: string }>).map((a) => a.id)).toEqual([first.id]);
  });

  it("refuses what it does not keep, a record that is not there, and a record the app cannot see", async () => {
    const customer = await ok("createCustomer", { name: "Refusals" });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>').toString("base64");
    const refused = await call("uploadAttachment", { entityType: "customer", entityId: customer.id, fileName: "x.svg", contentType: "image/svg+xml", bytes: svg });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("SVG");

    const missing = await call("uploadAttachment", { entityType: "invoice", entityId: fixtureId("no-such-invoice"), fileName: "a.png", bytes: png });
    expect(missing.status).toBe(404);

    const blind = await call("uploadAttachment",
      { entityType: "customer", entityId: customer.id, fileName: "a.png", bytes: png },
      { ctx: app(["document:write", "job:read"]) });
    expect(blind.status).toBe(403);
  });
});
