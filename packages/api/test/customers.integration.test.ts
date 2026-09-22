import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createClient } from "@opentradesos/db";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import { PermissionError } from "@opentradesos/core";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg } from "./helpers";

/**
 * Service layer against a real database.
 *
 * Unit tests prove the permission catalogue is coherent. Only this proves the
 * four steps actually happen in order against Postgres: the permission check,
 * the tenant boundary, the scope, and the redaction.
 */
const url = process.env.DATABASE_URL;

// A contributor without a database still gets a green suite. CI does not get
// that privilege: these tests are the only thing standing between a schema
// change and a cross tenant leak, and a run that quietly skips them reads
// green while proving nothing.
if (!url && process.env.CI) {
  throw new Error(
    "DATABASE_URL is not set. These tests must run in CI, not skip.",
  );
}

const run = url ? describe : describe.skip;

const ORG_A = "cccc1111-1111-1111-1111-111111111111";
const ORG_B = "cccc2222-2222-2222-2222-222222222222";
const USER_A = "dddd1111-1111-1111-1111-111111111111";
const USER_B = "dddd2222-2222-2222-2222-222222222222";

let raw: postgres.Sql;
const db = () => createClient(url!);

const ctxFor = (organizationId: string, userId: string, roles: Actor["roles"], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId, organizationId, roles },
  db: db(),
  ...extra,
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG_A, userId: USER_A, name: "Acme HVAC", slug: "acme-svc" });
  await seedOrg(raw, { organizationId: ORG_B, userId: USER_B, name: "Beta Plumbing", slug: "beta-svc" });
});

afterAll(async () => { if (raw) await raw.end(); });

run("permission enforcement", () => {
  it("refuses a read to a role without the permission", async () => {
    // readonly holds customer:read, so use a role that genuinely does not.
    const ctx = ctxFor(ORG_A, USER_A, []);
    await expect(customers.list(ctx, { limit: 10, includeInactive: false })).rejects.toThrow(PermissionError);
  });

  it("refuses a write to a technician", async () => {
    const ctx = ctxFor(ORG_A, USER_A, ["technician"]);
    await expect(customers.create(ctx, {
      type: "residential", name: "Nope", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
    })).rejects.toThrow(PermissionError);
  });

  it("names the missing permission, so an error is actionable", async () => {
    const ctx = ctxFor(ORG_A, USER_A, ["technician"]);
    try {
      await customers.create(ctx, {
        type: "residential", name: "Nope", paymentTermsDays: 0,
        taxExempt: false, tags: [], customFields: {},
      });
      expect.unreachable();
    } catch (e) {
      expect((e as PermissionError).permission).toBe("customer:write");
    }
  });
});

run("creating a customer", () => {
  it("creates the customer and its first property in one transaction", async () => {
    const ctx = ctxFor(ORG_A, USER_A, ["owner"]);
    const created = await customers.create(ctx, {
      type: "residential", name: "Delacroix", email: "d@example.test",
      paymentTermsDays: 0, taxExempt: false, tags: ["vip"], customFields: {},
      property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
    });

    expect(created.name).toBe("Delacroix");
    // Scoped. Counting unscoped means another test file's rows land here, and
    // the failure looks like a bug in this code rather than in the assertion.
    const props = await raw`select count(*)::int as n from public.property where organization_id = ${ORG_A}`;
    expect(props[0]!.n).toBe(1);
    const links = await raw`select count(*)::int as n from public.customer_property where organization_id = ${ORG_A}`;
    expect(links[0]!.n).toBe(1);
  });

  it("writes an audit entry", async () => {
    const rows = await raw`select action, actor_user_id from public.audit_log
      where organization_id = ${ORG_A} and action = 'customer.created'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actor_user_id).toBe(USER_A);
  });

  it("is idempotent, so a retry does not create a second customer", async () => {
    const key = "retry-key-0001";
    const input = {
      type: "residential" as const, name: "Retried Once", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
    };
    const first = await customers.create(ctxFor(ORG_A, USER_A, ["owner"], { idempotencyKey: key }), input);
    const second = await customers.create(ctxFor(ORG_A, USER_A, ["owner"], { idempotencyKey: key }), input);

    expect(second.id).toBe(first.id);
    const rows = await raw`select count(*)::int as n from public.customer
      where organization_id = ${ORG_A} and name = 'Retried Once'`;
    expect(rows[0]!.n).toBe(1);
  });

  it("records the agent when an agent is acting", async () => {
    await customers.create(
      ctxFor(ORG_A, USER_A, ["owner"], { agentId: "intake-agent" }),
      { type: "residential", name: "Booked By Agent", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {} },
    );
    const rows = await raw`select actor_agent_id from public.audit_log
      where organization_id = ${ORG_A} and action = 'customer.created' and actor_agent_id is not null`;
    expect(rows[0]!.actor_agent_id).toBe("intake-agent");
  });
});

run("tenant isolation through the service", () => {
  it("never returns another tenant's customers", async () => {
    await customers.create(ctxFor(ORG_B, USER_B, ["owner"]), {
      type: "residential", name: "Beta Only", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });

    const a = await customers.list(ctxFor(ORG_A, USER_A, ["owner"]), { limit: 50, includeInactive: false });
    expect(a.data.some((c) => c.name === "Beta Only")).toBe(false);

    const b = await customers.list(ctxFor(ORG_B, USER_B, ["owner"]), { limit: 50, includeInactive: false });
    expect(b.data.map((c) => c.name)).toEqual(["Beta Only"]);
  });

  it("returns not found, not another tenant's row, on a direct id lookup", async () => {
    const [betaCustomer] = await raw`select id from public.customer
      where organization_id = ${ORG_B} and name = 'Beta Only'`;
    await expect(
      customers.get(ctxFor(ORG_A, USER_A, ["owner"]), { id: betaCustomer!.id }),
    ).rejects.toThrow(NotFoundError);
  });
});

run("pagination", () => {
  it("pages without repeating or skipping a row", async () => {
    const ctx = ctxFor(ORG_A, USER_A, ["owner"]);
    for (let i = 0; i < 7; i++) {
      await customers.create(ctx, {
        type: "residential", name: `Paged ${String(i).padStart(2, "0")}`,
        paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await customers.list(ctx, { limit: 3, includeInactive: false, ...(cursor ? { cursor } : {}) });
      seen.push(...res.data.map((c) => c.id as string));
      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
    }

    expect(new Set(seen).size, "a row appeared on two pages").toBe(seen.length);
    const total = await raw`select count(*)::int as n from public.customer where organization_id = ${ORG_A}`;
    expect(seen.length).toBe(total[0]!.n);
  });
});
