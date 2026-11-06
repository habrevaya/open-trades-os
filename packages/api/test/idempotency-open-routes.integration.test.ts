import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as forms from "../src/services/forms";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as estimates from "../src/services/estimates";
import * as portal from "../src/services/portal";
import type { ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { routes, routeList } from "../src/contracts/index";
import { buildOpenApiDocument } from "../src/lib/openapi";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE IDEMPOTENCY KEY ON ROUTES WITH NO SESSION (M26)
 *
 * The OpenAPI document said a retry of an idempotent grant or public route
 * "is NOT currently a no-op", and left the header off them, so the SDK sent
 * no key and never retried the website chat's message. The dispatcher has
 * handed the key to every route for a while. These check what is true now,
 * through the dispatcher: an open route keyed on the header answers a repeat
 * with the first answer, a portal route whose effect is a state is a no-op
 * on a repeat, and the document marks the header on exactly the routes that
 * declare themselves idempotent.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("idem-open:org");
const USER = fixtureId("idem-open:user");
const SLUG = "idempotency-open-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

async function post(path: string, body: unknown, key?: string) {
  const response = await dispatch(new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  }), { db: db(), resolveSession: async () => null });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Idempotency Co", slug: SLUG });
  customerId = (await customers.create(owner(), {
    type: "residential", name: "Rhea Retry", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  propertyId = (await properties.create(owner(), {
    address: { line1: "5 Retry Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  await forms.save(owner(), {
    slug: "call-me", title: "Call me", source: "organic_search",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "phone", label: "Phone", type: "phone", required: true },
    ],
    minimumFillSeconds: 0,
  });
});

afterAll(async () => { if (raw) await raw.end(); });

describe("the document", () => {
  it("marks the header on every idempotent route, whoever may call it, and on no other", () => {
    const document = buildOpenApiDocument(routes);
    let open = 0;
    for (const route of routeList) {
      const operation = (document.paths[route.path] as Record<string, { parameters?: { name: string }[] }>)[route.method];
      const takesKey = (operation?.parameters ?? []).some((p) => p.name === "idempotency-key");
      expect(takesKey, `${route.method} ${route.path}`).toBe(route.idempotent === true);
      if (takesKey && (route.authorization ?? "session") !== "session") open += 1;
    }
    // The open and portal routes that key a repeat, or are a no-op on one, are among them.
    expect(open).toBeGreaterThan(20);
    expect(JSON.stringify(document)).not.toContain("NOT currently a no-op");
  });
});

run("a repeat through the dispatcher, with no session", () => {
  it("a public form posted twice with one key is one submission, and the first answer", async () => {
    const body = { organizationSlug: SLUG, values: { name: "Rhea Retry", phone: "5125550177" }, startedAt: new Date(Date.now() - 30_000).toISOString() };
    const key = `idem-open-form-${Date.now()}`;
    const first = await post("/v1/public/forms/call-me", body, key);
    const second = await post("/v1/public/forms/call-me", body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body["submissionId"]).toBe(first.body["submissionId"]);
    const [once] = await raw<{ count: number }[]>`
      select count(*)::int as count from public.form_submission where organization_id = ${ORG}`;
    expect(once!.count).toBe(1);

    // Without a key, a second post is a second submission: the key is what makes it one.
    await post("/v1/public/forms/call-me", body);
    const [after] = await raw<{ count: number }[]>`
      select count(*)::int as count from public.form_submission where organization_id = ${ORG}`;
    expect(after!.count).toBe(2);
  });

  it("an estimate declined twice from its link is declined once, and the office told once", async () => {
    const estimate = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0", title: "A new water heater",
      options: [{ name: "Tank", isRecommended: true, lines: [{ name: "Tank", quantity: "1", unitPrice: "1800.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] }],
    });
    const grant = await portal.issueGrant(owner(), { customerId, scope: "estimate", subjectId: estimate.id, expiresInDays: 30 });
    const token = grant.url.split("/").pop()!;

    const first = await post("/v1/portal/estimate/decline", { token, reason: "Too dear" });
    const second = await post("/v1/portal/estimate/decline", { token, reason: "Too dear" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ ok: true });

    const events = await raw<{ kind: string }[]>`
      select kind from public.portal_event where organization_id = ${ORG} and estimate_id = ${estimate.id} and kind = 'estimate_declined'`;
    expect(events).toHaveLength(1);
  });
});
