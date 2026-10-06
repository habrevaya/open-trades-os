import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as roleService from "../src/services/roles";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { dispatch } from "../src/http/dispatch";
import { memberActor } from "../src/services/session";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE COMPANY'S OWN ROLES, OVER THE API, AND THE WHOLE COMPANY FIX
 *
 * A role bigger than its author was refused by the service with
 * `RoleEscalationError`, which the HTTP layer had no mapping for, so an
 * integration got a 500 "Internal error" for what is a permission refusal.
 * It is a 403 now, with the sentence and which permissions or records it
 * was about.
 *
 * And a role saved by the roles screen as "the whole company" before that
 * choice was written out names no scope, so its holders have been seeing
 * their own work only. The fix is one call somebody makes on purpose; this
 * asks that it widens exactly that role, only for somebody who sees the
 * whole company, and that nothing changes without it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("custom-roles-api:org");
const OWNER = fixtureId("custom-roles-api:owner");
const OLIVE = fixtureId("custom-roles-api:olive");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<Actor> = {}): ServiceContext =>
  ({ actor: { userId: OWNER, organizationId: ORG, roles, ...extra }, db: db() });
const owner = () => as(["owner"]);

let key = 0;
async function call(method: string, path: string, ctx: ServiceContext, body?: unknown) {
  key += 1;
  const response = await dispatch(new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": `custom-roles-api-${Date.now()}-${key}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { db: db(), resolveSession: async () => ctx });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

let oliveMembership = "";
let oldRole = "";
let otherJob = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Roles Over The Wire", slug: "custom-roles-api" });
  await raw`delete from public."user" where id = ${OLIVE} or email = 'custom-roles-api-olive@test.local'`;
  await raw`insert into public."user" (id, email, name) values (${OLIVE}, 'custom-roles-api-olive@test.local', 'Olive Office')`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${OLIVE}, 'office_manager') returning id`;
  oliveMembership = m!.id;

  /** A role as the roles screen saved "the whole company" before it wrote the choice out: no scopes at all. */
  const [r] = await raw<{ id: string }[]>`
    insert into public.role (organization_id, name, based_on, permissions, scopes)
    values (${ORG}, 'Old office role', 'office_manager', ${raw.json(["job:read", "customer:read"])}, '{}'::jsonb) returning id`;
  oldRole = r!.id;

  const customerId = (await customers.create(owner(), {
    type: "residential", name: "Somebody Else's Customer", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id as string;
  const propertyId = (await properties.create(owner(), {
    address: { line1: "4 Wire St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
  otherJob = (await jobs.create(owner(), { customerId, propertyId, summary: "Not Olive's job", tags: [], customFields: {} })).id as string;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a role bigger than its author, over HTTP", () => {
  it("is a 403 with the sentence and the permissions it carries that the caller does not hold", async () => {
    const response = await call("POST", "/v1/roles", as(["office_manager"], { grants: ["role:write"] }), {
      name: "Payroll clerk", permissions: ["payroll:read", "job:read"],
      scopes: { job: "all" },
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatch(/permissions you do not hold yourself: payroll:read/);
    expect(response.body["reason"]).toBe("missing_permission");
    expect(response.body["permissions"]).toEqual(["payroll:read"]);
  });

  it("is a 403 saying it sees more of the company, for somebody limited to their own work", async () => {
    const response = await call("POST", "/v1/roles", as(["technician"], { grants: ["role:write"] }), {
      name: "Sees everything", permissions: ["job:read"], scopes: { job: "all" },
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatch(/see more of the company than you do/);
    expect(response.body["reason"]).toBe("widens_scope");
  });

  it("is made, listed and removed by somebody who holds it all", async () => {
    const made = await call("POST", "/v1/roles", owner(), {
      name: "Night dispatcher", permissions: ["visit:read", "visit:dispatch"],
      scopes: { visit: "all", job: "all" },
    });
    expect(made.status).toBeLessThan(300);
    expect(made.body["namesNoScope"]).toBe(false);
    const listed = await call("GET", "/v1/roles", owner());
    const roles = listed.body["roles"] as { id: string; name: string; namesNoScope: boolean }[];
    expect(roles.find((r) => r.id === made.body["id"])?.name).toBe("Night dispatcher");
    expect(roles.find((r) => r.id === oldRole)?.namesNoScope).toBe(true);
    const removed = await call("POST", `/v1/roles/${made.body["id"] as string}/remove`, owner());
    expect(removed.body).toEqual({ id: made.body["id"], removed: true });
  });

  it("refuses handing somebody a role over HTTP without user:write, and demoting somebody who holds more", async () => {
    const csr = await call("POST", `/v1/memberships/${oliveMembership}/custom-role`, as(["csr"]), { roleId: oldRole });
    expect(csr.status).toBe(403);
    const small = await roleService.create(owner(), { name: "Tiny", permissions: ["job:read"], scopes: { job: "own" } });
    // Olive holds the office manager's expense approval, which an administrator does not, so not by them either.
    await expect(roleService.assignCustomRole(as(["admin"], { userId: fixtureId("custom-roles-api:admin") }), {
      membershipId: oliveMembership, roleId: small.id,
    })).rejects.toBeInstanceOf(roleService.RoleEscalationError);
    // An administrator cannot hand the owner a smaller role: the owner holds payroll, the administrator does not.
    const [ownerMembership] = await raw<{ id: string }[]>`
      select id from public.membership where organization_id = ${ORG} and user_id = ${OWNER}`;
    const demote = await call("POST", `/v1/memberships/${ownerMembership!.id}/custom-role`,
      as(["admin"], { userId: fixtureId("custom-roles-api:admin") }), { roleId: small.id });
    expect(demote.status).toBe(403);
    expect(demote.body["reason"]).toBe("missing_permission");
  });
});

run("a role saved before \"the whole company\" was written out", () => {
  it("shows its holder their own work only until the fix, and changes nothing by itself", async () => {
    await roleService.assignCustomRole(owner(), { membershipId: oliveMembership, roleId: oldRole });
    const olive = await inTenant(owner(), (tx) => memberActor(tx, ORG, OLIVE));
    const before = await jobs.list({ actor: olive!, db: db() }, { limit: 100 });
    expect(before.data.map((j) => j.id)).not.toContain(otherJob);
    const [row] = await raw<{ scopes: Record<string, string> }[]>`select scopes from public.role where id = ${oldRole}`;
    expect(row!.scopes).toEqual({});
  });

  it("is refused to somebody who does not see the whole company, as a 403", async () => {
    const limited = await call("POST", `/v1/roles/${oldRole}/whole-company`,
      as(["branch_manager"], { grants: ["role:write"], businessUnitId: fixtureId("custom-roles-api:branch") }));
    expect(limited.status).toBe(403);
    expect(limited.body["reason"]).toBe("widens_scope");
  });

  it("gives every scoped record the whole company when the owner asks, and its holder then sees every job", async () => {
    const fixed = await call("POST", `/v1/roles/${oldRole}/whole-company`, owner());
    expect(fixed.status).toBeLessThan(300);
    expect(fixed.body["namesNoScope"]).toBe(false);
    expect(Object.values(fixed.body["scopes"] as Record<string, string>).every((s) => s === "all")).toBe(true);
    const olive = await inTenant(owner(), (tx) => memberActor(tx, ORG, OLIVE));
    const after = await jobs.list({ actor: olive!, db: db() }, { limit: 100 });
    expect(after.data.map((j) => j.id)).toContain(otherJob);
  });

  it("is refused for a role that already says what it sees", async () => {
    await expect(roleService.giveWholeCompany(owner(), { id: oldRole })).rejects.toBeInstanceOf(ConflictError);
  });

  it("needs role:write at all", async () => {
    await expect(roleService.giveWholeCompany(as(["csr"]), { id: oldRole })).rejects.toBeInstanceOf(PermissionError);
  });
});
