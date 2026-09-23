import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { routes, type RouteName } from "../src/contracts/index";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * WHAT THE DOCUMENT PROMISES AND WHAT THE HANDLER RETURNS
 *
 * The dispatcher validates INPUT against the contract and does not validate
 * output. That is the right runtime behaviour, because a service returning a
 * redacted view of its own contract is correct rather than a mismatch to
 * paper over, and failing a request at the last moment over a shape helps
 * nobody.
 *
 * It does leave one gap, and it is the gap a contract layer creates rather
 * than closes: the OpenAPI document and the MCP tool list are generated from
 * these output schemas, so a schema that does not describe what the handler
 * actually produces ships as a promise to every generated client. Nothing
 * else in this suite would catch it: the service tests call the service
 * directly and never see the contract, and the contract tests read the
 * definitions and never call anything.
 *
 * So this drives the routes through the real dispatcher and parses every
 * response with the schema the document was generated from. The failure it
 * exists for is a field published non-optionally that comes back undefined,
 * which is the shape that turns into a runtime error in somebody's generated
 * client rather than in our tests.
 *
 * Scoped to the routes most recently given contracts. Inventory, purchasing
 * and timesheets were services and screens with no contracts at all, so
 * until now every one of these shapes was written without anything ever
 * comparing it to a response.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("shapes:org");
const USER = fixtureId("shapes:user");

let raw: postgres.Sql;
let itemId = "";
let warehouse = "";
let van = "";
let jobId = "";
let technicianId = "";
let vendorId = "";

const db = () => testDb(url!);
const ctx = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/**
 * One call through the real dispatcher, parsed with the declared output.
 *
 * The parse is `safeParse` and the assertion names the route and the issues,
 * because "expected undefined to be defined" on a generated schema is a
 * message somebody spends twenty minutes locating.
 */
async function callRoute(
  name: RouteName,
  input: Record<string, unknown> = {},
  pathParams: Record<string, string> = {},
): Promise<unknown> {
  const route = routes[name] as { method: string; path: string; output: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } };

  let path = route.path;
  for (const [key, value] of Object.entries(pathParams)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  expect(path, `${name} still has an unfilled path parameter`).not.toContain("{");

  const isRead = route.method === "get" || route.method === "delete";
  const query = isRead
    ? "?" + new URLSearchParams(
        Object.entries(input).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString()
    : "";

  const response = await dispatch(
    new Request(`http://localhost${path}${query}`, {
      method: route.method.toUpperCase(),
      ...(isRead ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    }),
    { db: db(), resolveSession: async () => ctx() },
  );

  const body: unknown = await response.json();
  /** A create answers 201, a read 200. Both are the route working. */
  expect([200, 201], `${name} failed: ${JSON.stringify(body)}`).toContain(response.status);

  const parsed = route.output.safeParse(body);
  expect(
    parsed.success,
    `${name} returned something its published output schema rejects, so every generated client is promised a shape the handler does not produce: ${JSON.stringify(parsed.error)}`,
  ).toBe(true);

  return body;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Shapes Co", slug: "shapes-co" });

  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code)
    values (${ORG}, 'material', 'CAP-45') returning id`;
  itemId = item!.id;
  await raw`
    insert into public.price_book_item_version
      (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${itemId}, 1, 'Capacitor, 45 uF', '28.00', now())`;

  const [shop] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name, is_warehouse)
    values (${ORG}, 'Shop', true) returning id`;
  warehouse = shop!.id;
  const [truck] = await raw<{ id: string }[]>`
    insert into public.location (organization_id, name) values (${ORG}, 'Van 2') returning id`;
  van = truck!.id;

  const customer = await customers.create(ctx(), {
    type: "residential", name: "Shapes Customer", phone: "+15125550177",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(ctx(), {
    address: { line1: "2 Shape St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(ctx(), {
    customerId: customer.id, propertyId: property.id, summary: "Shapes job", tags: [], customFields: {},
  });
  jobId = job.id;

  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [technician] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membership!.id}, 'Dee Okafor', 'Journeyman') returning id`;
  technicianId = technician!.id;

  await raw`insert into public.overtime_policy
    (organization_id, label, time_zone, week_starts_on, day_attribution,
     weekly_threshold_minutes, overtime_multiplier, double_time_multiplier,
     on_call_treatment, note)
    values (${ORG}, 'Federal', 'America/Chicago', 1, 'shift_start', 2400,
            '1.5', '2', 'separate_rate_not_hours_worked', 'Forty at time and a half.')`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("stock reaches the HTTP API in the shape the document promises", () => {
  it("publishes exactly the movement fields the document declares", async () => {
    /**
     * Zod strips unknown keys, so the schema parse in `callRoute` passes
     * whatever extra columns a handler happens to return. That is the
     * failure this asserts separately: the row carries `organizationId`,
     * `recordedByUserId` and the soft delete columns, none of which belong
     * on the wire, and a document that omits what the API actually sends is
     * a document nobody can generate an exact client from.
     */
    const body = await callRoute("receiveStock", {
      itemId, locationId: warehouse, quantity: "1", totalCost: "28.00",
    }) as { movements: Record<string, unknown>[] };

    expect(Object.keys(body.movements[0]!).sort()).toEqual([
      "id", "itemId", "jobId", "kind", "locationId", "occurredAt",
      "quantity", "reasonCode", "sequence", "totalCost", "transferId",
    ]);
  });

  it("receives, reserves, issues and releases", async () => {
    await callRoute("receiveStock", {
      itemId, locationId: warehouse, quantity: "4", totalCost: "112.00",
    });
    await callRoute("reserveStock", { itemId, locationId: warehouse, jobId, quantity: "2" });
    await callRoute("issueStock", { itemId, locationId: warehouse, jobId, quantity: "1" });
    await callRoute("releaseStock", { itemId, locationId: warehouse, jobId, quantity: "1" });
  });

  it("transfers, counts, and reads levels back", async () => {
    await callRoute("transferStock", {
      itemId, fromLocationId: warehouse, toLocationId: van, quantity: "1",
    });
    await callRoute("countStock", {
      itemId, locationId: van, counted: "0", reasonCode: "cycle_count",
    });

    const body = await callRoute("listStockLevels") as { levels: { locationId: string }[] };
    /**
     * Non-vacuity. A response of `{ levels: [] }` satisfies the schema, so
     * without this the parse above would prove nothing about the row shape.
     */
    expect(body.levels.length).toBeGreaterThan(0);
  });

  it("lists commitments, suggestions and the job's material cost", async () => {
    await callRoute("receiveStock", {
      itemId, locationId: warehouse, quantity: "2", totalCost: "56.00",
    });
    await callRoute("reserveStock", { itemId, locationId: warehouse, jobId, quantity: "1" });

    const held = await callRoute("listCommitments") as { commitments: unknown[] };
    expect(held.commitments.length).toBeGreaterThan(0);

    await raw`insert into public.reorder_policy
      (organization_id, item_id, location_id, reorder_point, reorder_quantity)
      values (${ORG}, ${itemId}, ${warehouse}, '100.0000', '50.0000')`;
    const suggested = await callRoute("listReorderSuggestions") as { suggestions: unknown[] };
    expect(suggested.suggestions.length).toBeGreaterThan(0);
    await raw`delete from public.reorder_policy where organization_id = ${ORG}`;

    await callRoute("getJobMaterialCost", {}, { jobId });
  });
});

run("purchasing reaches the HTTP API", () => {
  it("creates a vendor, raises an order, submits it and receives it", async () => {
    const vendor = await callRoute("createVendor", {
      name: "Austin Supply", accountNumber: "AS-114",
    }) as { id: string };
    vendorId = vendor.id;

    const listed = await callRoute("listVendors") as { vendors: unknown[] };
    expect(listed.vendors.length).toBeGreaterThan(0);

    const order = await callRoute("createPurchaseOrder", {
      vendorId,
      defaultLocationId: warehouse,
      lines: [{ itemId, quantity: "10", unitPrice: "26.00" }],
    }) as { id: string };

    await callRoute("setPurchaseOrderStatus", { status: "submitted" }, { id: order.id });

    const orders = await callRoute("listPurchaseOrders") as {
      purchaseOrders: { id: string; lineCount: number }[];
    };
    const mine = orders.purchaseOrders.find((o) => o.id === order.id);
    expect(mine?.lineCount).toBe(1);

    const [line] = await raw<{ id: string }[]>`
      select id from public.purchase_order_line where purchase_order_id = ${order.id}`;

    /**
     * A PARTIAL receipt, because that is the case a system gets wrong: three
     * of ten arrive, seven are still owed, and a service that closes the
     * order on any receipt loses them. A full receipt would pass whether or
     * not that works.
     */
    const received = await callRoute(
      "receivePurchaseOrder",
      { lines: [{ lineId: line!.id, quantity: "3" }] },
      { id: order.id },
    ) as { status: string };
    expect(received.status).toBe("partially_received");

    /**
     * And again from the database, because the response carries what core
     * COMPUTED and the row carries what was WRITTEN. Asserting only the
     * response leaves the write unchecked: forcing the update to "received"
     * left this test green until the read below was added.
     */
    const after = await callRoute("listPurchaseOrders") as {
      purchaseOrders: { id: string; status: string; outstanding: boolean }[];
    };
    const persisted = after.purchaseOrders.find((o) => o.id === order.id);
    expect(persisted?.status).toBe("partially_received");
    expect(persisted?.outstanding, "seven are still owed").toBe(true);
  });
});

run("timesheets reach the HTTP API", () => {
  it("returns a week, its entries, and the policy that classified it", async () => {
    const started = new Date(Date.UTC(2026, 0, 5, 14));
    const ended = new Date(Date.UTC(2026, 0, 5, 22));
    const [entry] = await raw<{ id: string }[]>`
      insert into public.timeclock_entry
        (organization_id, technician_id, kind, started_at, ended_at, minutes)
      values (${ORG}, ${technicianId}, 'on_site', ${started}, ${ended}, 480)
      returning id`;

    const week = await callRoute("getTimesheetWeek", { weekOf: "2026-01-07" }) as {
      rows: { totalHours: string }[];
    };
    /**
     * The week is asked for by a date INSIDE it, not by its start, because
     * the start comes from the policy. A test that passed the Monday would
     * pass against a resolver that ignored the policy entirely.
     */
    expect(week.rows.length).toBeGreaterThan(0);
    expect(week.rows[0]!.totalHours).toBe("8.00");

    const entries = await callRoute("listTimeEntries", {
      technicianId, weekOf: "2026-01-07",
    }) as { entries: unknown[] };
    expect(entries.entries.length).toBe(1);

    const approved = await callRoute("approveTimeEntries", { entryIds: [entry!.id] }) as {
      approved: number;
    };
    expect(approved.approved).toBe(1);

    await raw`delete from public.timeclock_entry where organization_id = ${ORG}`;
  });
});

run("files reach the HTTP API", () => {
  it("drains a queued upload and reports what is outstanding", async () => {
    const [membership] = await raw<{ id: string }[]>`select id from public.membership
      where organization_id = ${ORG} and user_id = ${USER}`;
    const [device] = await raw<{ id: string }[]>`insert into public.device
      (organization_id, technician_id, installation_id, platform)
      values (${ORG}, ${technicianId}, 'shapes-install', 'android') returning id`;
    void membership;

    const visit = await jobs.addVisit(ctx(), {
      id: jobId,
      windowStart: new Date(Date.now() + 86_400_000).toISOString(),
      windowEnd: new Date(Date.now() + 90_000_000).toISOString(),
      estimatedDurationMinutes: 60,
      technicianIds: [],
    });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 42]);
    await raw`insert into public.field_upload
      (organization_id, device_id, client_id, subject_type, subject_id, content_type)
      values (${ORG}, ${device!.id}, 'shapes-upload', 'visit', ${visit.id}, 'image/jpeg')`;

    const pending = await callRoute("listPendingUploads", { deviceId: device!.id }) as {
      uploads: { clientId: string }[];
    };
    expect(pending.uploads.map((u) => u.clientId)).toContain("shapes-upload");

    const stored = await callRoute("storeUpload", {
      bytes: png.toString("base64"),
      caption: "After",
    }, { clientId: "shapes-upload" }) as { stored: boolean; storageKey: string | null };
    expect(stored.stored).toBe(true);
    expect(stored.storageKey).toBeTruthy();

    const attached = await callRoute("listAttachments", {
      entityType: "visit", entityId: visit.id,
    }) as { attachments: unknown[] };
    expect(attached.attachments.length).toBe(1);

    const outstanding = await callRoute("getUploadStatus", {
      subjectType: "visit", subjectId: visit.id,
    }) as { stored: number; pending: number };
    expect(outstanding).toMatchObject({ stored: 1, pending: 0 });
  });

  it("records a failure the device reports", async () => {
    const [device] = await raw<{ id: string }[]>`insert into public.device
      (organization_id, technician_id, installation_id, platform)
      values (${ORG}, ${technicianId}, 'shapes-install-2', 'android') returning id`;
    await raw`insert into public.field_upload
      (organization_id, device_id, client_id, subject_type, content_type)
      values (${ORG}, ${device!.id}, 'shapes-fail', 'visit', 'image/jpeg')`;

    const result = await callRoute("failUpload", {
      error: "No signal.",
    }, { clientId: "shapes-fail" }) as { status: string; willRetry: boolean };
    expect(result).toMatchObject({ status: "failed", willRetry: true });
  });
});

run("calls reach the HTTP API", () => {
  it("logs a call, decides recording, and stores a redacted transcript", async () => {
    await callRoute("setRecordingPolicy", {
      jurisdiction: "TX", rule: "one_party", announcementRequired: false,
      note: "One participant's agreement is enough here.",
    });

    const call = await callRoute("logCall", {
      direction: "inbound", fromE164: "+15125550123", toE164: "+15125550100",
      status: "completed",
    }) as { id: string };

    const decision = await callRoute("decideRecording", {
      parties: [{ role: "caller", jurisdiction: "TX", consented: true }],
      announcementPlayed: false,
    }, { id: call.id }) as { permitted: boolean; refusal: string | null };
    expect(decision.permitted).toBe(true);
    expect(decision.refusal).toBeNull();

    await callRoute("attachRecording", { recordingUrl: "s3://calls/x.mp3" }, { id: call.id });

    const stored = await callRoute("attachTranscript", {
      segments: [
        { speaker: "agent", startMs: 0, endMs: 2000, text: "Card number?", confidence: 0.95 },
        { speaker: "caller", startMs: 2000, endMs: 6000, text: "4111 1111 1111 1111", confidence: 0.9 },
      ],
    }, { id: call.id }) as { redacted: boolean; call: { transcript: string } };
    expect(stored.redacted).toBe(true);
    expect(stored.call.transcript).not.toContain("4111 1111 1111 1111");

    await callRoute("deleteRecording", { reason: "Asked to." }, { id: call.id });

    const listed = await callRoute("listCalls", { limit: 10 }) as { calls: unknown[] };
    expect(listed.calls.length).toBeGreaterThan(0);

    await callRoute("getCall", {}, { id: call.id });
    await callRoute("listRecordingPolicies");
    await callRoute("removeRecordingPolicy", {}, { jurisdiction: "TX" });
  });
});
