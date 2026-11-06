import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as agreements from "../src/services/agreements";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { routes } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE BOOK'S UNEARNED TOTAL OVER THE API (M08)
 *
 * The Agreements screen showed what the whole book holds deferred and the API
 * had only each agreement's own. `GET /v1/agreement-book/unearned` is the
 * screen's figure, from the same service, for whoever may read agreements.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ag-unearned:org");
const USER = fixtureId("ag-unearned:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });

async function get(ctx: ServiceContext) {
  const response = await dispatch(new Request("http://x/v1/agreement-book/unearned"), { db: db(), resolveSession: async () => ctx });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Unearned Co", slug: "agreements-unearned-co" });
  const customerId = (await customers.create(as(["owner"]), {
    type: "residential", name: "Una Unearned", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const propertyId = (await properties.create(as(["owner"]), {
    address: { line1: "4 Deferred Dr", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  const plan = await agreements.createPlan(as(["owner"]), {
    name: "Comfort Club", price: "228.00", billingFrequency: "monthly", termMonths: 12, includedVisitsPerTerm: 2,
  });
  const second = await agreements.createPlan(as(["owner"]), {
    name: "Filter Club", price: "60.00", billingFrequency: "annual", termMonths: 12, includedVisitsPerTerm: 0,
  });
  await agreements.sell(as(["owner"]), { planId: plan.id, customerId, propertyId, startedOn: "2026-01-15" });
  await agreements.sell(as(["owner"]), { planId: second.id, customerId, propertyId, startedOn: "2026-02-01" });
});

afterAll(async () => { if (raw) await raw.end(); });

run("the book's unearned total", () => {
  it("is the screen's figure, across every agreement", async () => {
    const answer = await get(as(["owner"]));
    expect(answer.status).toBe(200);
    routes.getAgreementBookUnearned.output.parse(answer.body);
    expect(answer.body).toEqual({ unearned: "288.0000", currency: "USD" });
    expect(answer.body["unearned"]).toBe(await agreements.unearned(as(["owner"])));
  });

  it("is read by the accountant, and refused to somebody who may not read agreements", async () => {
    expect((await get(as(["accountant"]))).body["unearned"]).toBe("288.0000");
    expect((await get(as(["dispatcher"]))).status).toBe(403);
    expect((await get(as(["technician"]))).status).toBe(403);
  });
});
