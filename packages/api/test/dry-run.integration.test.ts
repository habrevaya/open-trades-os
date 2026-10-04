import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as properties from "../src/services/properties";
import { dispatch } from "../src/http/dispatch";
import { handleMcp } from "../src/mcp/server";
import { allTools } from "../src/mcp/tools";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A DRY RUN CHANGES NOTHING AND SAYS EVERYTHING
 *
 * The route runs, exactly as it would, and is rolled back. These tests hold
 * the two halves: after a dry run the database is as it was, and the report
 * names what would have changed, by table and by record.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("dryrun:org");
const USER = fixtureId("dryrun:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const deps = () => ({ db: db(), resolveSession: async () => owner() });

const jobIds: string[] = [];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Dry Run Co", slug: "dry-run-co" });
  for (const name of ["Ada", "Bea", "Cy"]) {
    const customer = await customers.create(owner(), {
      type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: ["VIP"], customFields: {},
    });
    const property = await properties.create(owner(), {
      address: { line1: `1 ${name} St`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    const job = await jobs.create(owner(), { customerId: customer.id, propertyId: property.id, summary: "Dry", tags: [], customFields: {} });
    jobIds.push(job.id);
  }
});

afterAll(async () => {
  if (raw) await raw.end();
});

const tagCount = async (tag: string) => {
  const [row] = await raw<{ n: number }[]>`
    select count(*)::int as n from public.customer where organization_id = ${ORG} and tags ? ${tag}`;
  return row!.n;
};

run("a dry run over HTTP", () => {
  it("reports what renaming a tag would change, and changes nothing", async () => {
    const response = await dispatch(new Request("http://x/v1/customer-tags/rename", {
      method: "POST",
      headers: { "content-type": "application/json", "x-otos-dry-run": "true", "idempotency-key": "dry-rename-1" },
      body: JSON.stringify({ from: "VIP", to: "Gold" }),
    }), deps());
    expect(response.status).toBe(200);
    const report = await response.json() as {
      dryRun: boolean; wouldReturn: { customers: number };
      tables: Array<{ table: string; updated: number }>; auditTotal: number;
    };
    expect(report.dryRun).toBe(true);
    expect(report.wouldReturn.customers).toBe(3);
    expect(report.tables.find((t) => t.table === "customer")?.updated).toBe(3);

    expect(await tagCount("VIP")).toBe(3);
    expect(await tagCount("Gold")).toBe(0);

    // The key a dry run carried is still unused: the real call does the work.
    const real = await dispatch(new Request("http://x/v1/customer-tags/rename", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "dry-rename-1" },
      body: JSON.stringify({ from: "VIP", to: "Gold" }),
    }), deps());
    expect(real.status).toBe(201);
    expect(await tagCount("Gold")).toBe(3);
    // Put it back for the next test.
    await dispatch(new Request("http://x/v1/customer-tags/rename", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "dry-rename-back" },
      body: JSON.stringify({ from: "Gold", to: "VIP" }),
    }), deps());
  });

  it("names every record a bulk move would touch, through the audit lines it would write", async () => {
    const before = await raw<{ id: string; business_unit_id: string | null }[]>`
      select id, business_unit_id from public.job where organization_id = ${ORG}`;
    const [unit] = await raw<{ id: string }[]>`
      insert into public.business_unit (organization_id, name) values (${ORG}, 'North') returning id`;
    const response = await dispatch(new Request("http://x/v1/branch-assignments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-otos-dry-run": "1" },
      body: JSON.stringify({ jobIds, businessUnitId: unit!.id }),
    }), deps());
    expect(response.status).toBe(200);
    const report = await response.json() as { audit: Array<{ entityType: string; entityId: string }>; auditTotal: number };
    expect(report.auditTotal).toBeGreaterThanOrEqual(3);
    expect(new Set(report.audit.filter((a) => a.entityType === "job").map((a) => a.entityId))).toEqual(new Set(jobIds));
    const after = await raw<{ id: string; business_unit_id: string | null }[]>`
      select id, business_unit_id from public.job where organization_id = ${ORG}`;
    expect(after).toEqual(before);
  });

  it("refuses a dry run on a route that has none, rather than running it for real", async () => {
    const response = await dispatch(new Request("http://x/v1/customers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-otos-dry-run": "true", "idempotency-key": "dry-create-1" },
      body: JSON.stringify({ type: "residential", name: "Should not exist", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {} }),
    }), deps());
    expect(response.status).toBe(400);
    const [row] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer where organization_id = ${ORG} and name = 'Should not exist'`;
    expect(row!.n).toBe(0);
  });
});

run("a dry run as an MCP tool", () => {
  it("is offered on bulk tools only", () => {
    const rename = allTools().find((t) => t.name === "otos_rename_customer_tag")!;
    expect(rename.inputSchema.properties).toHaveProperty("dryRun");
    expect(rename.description).toMatch(/dryRun: true first/);
    const create = allTools().find((t) => t.name === "otos_create_customer")!;
    expect(create.inputSchema.properties).not.toHaveProperty("dryRun");
  });

  it("runs and rolls back when the agent asks", async () => {
    const response = await handleMcp(new Request("http://x/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 9, method: "tools/call",
        params: { name: "otos_merge_customer_tags", arguments: { from: ["VIP"], into: "Platinum", dryRun: true, idempotencyKey: "mcp-dry-merge" } },
      }),
    }), { db: db(), resolveActor: async () => owner().actor, resolveSession: async () => owner() });
    const body = await response.json() as { result: { isError: boolean; structuredContent: { dryRun: boolean; wouldReturn: { customers: number } } } };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toMatchObject({ dryRun: true, wouldReturn: { customers: 3 } });
    expect(await tagCount("Platinum")).toBe(0);
    expect(await tagCount("VIP")).toBe(3);
  });
});
