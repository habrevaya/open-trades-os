import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import { dispatch, type DispatchDeps } from "../src/http/dispatch";
import { authenticate } from "../src/http/authenticate";
import { resolveSession } from "../src/services/session";
import * as apps from "../src/services/apps";
import * as booking from "../src/services/booking";
import * as portal from "../src/services/portal";
import * as setupTokens from "../src/services/setup-tokens";
import { inTenant, OrganizationSuspendedError, type ServiceContext } from "../src/services/context";
import { resetOrg, testDb } from "./helpers";
import type { Actor } from "@opentradesos/core";

/**
 * THE OPERATOR API, AGAINST A REAL DATABASE
 *
 * Everything that makes this surface safe is invisible to the compiler: the
 * role it drops to, the functions only that role may call, the trigger that
 * keeps a tenant away from its own suspension, and the SQL that stops a
 * suspended company's credentials resolving. So these tests go through the
 * HTTP layer and the real resolution paths, rather than calling the service
 * and trusting the wiring.
 *
 * The companies here are created BY the API, so their ids are not fixtures.
 * They are found and torn down by their external reference instead, which is
 * unique to this file.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const TOKEN = "op_" + "x".repeat(40);
const REF_PREFIX = "operator-test-";
const BASE = "https://ots.example.test";

let raw: postgres.Sql;
const db = (): Database => testDb(url!);

const deps = (overrides: Partial<DispatchDeps> = {}): DispatchDeps => ({
  db: db(),
  basePath: "/api",
  // The operator API must never ask for a session. If it ever did, this would
  // be the credential it found, and the test asserting on it would notice.
  resolveSession: async () => {
    throw new Error("the operator API read a session");
  },
  operator: { token: TOKEN, publicUrl: BASE },
  ...overrides,
});

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  dispatch(new Request(`${BASE}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), deps());

const read = (response: Response): Promise<any> => response.json();

const newCompany = (ref: string, email: string, extra: Record<string, unknown> = {}) => ({
  name: "Operator Test Plumbing",
  timezone: "America/Denver",
  externalRef: REF_PREFIX + ref,
  owner: { email, name: "Olive Owner" },
  ...extra,
});

async function cleanup(): Promise<void> {
  const orgs = await raw<{ id: string }[]>`
    select id from public.organization where external_ref like ${REF_PREFIX + "%"}`;
  for (const org of orgs) await resetOrg(raw, org.id);
  await raw`delete from public."user" where email like '%@operator.test'`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await cleanup();
});

afterAll(async () => {
  if (!url) return;
  await cleanup();
  await raw.end();
});

/** A live session for a user in an organization, the way sign in makes one. */
async function sessionFor(userId: string, organizationId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await raw`select app.create_session(${userId}::uuid, ${hash}, ${organizationId}::uuid,
            ${new Date(Date.now() + 864e5).toISOString()}::timestamptz)`;
  return hash;
}

run("creating a company", () => {
  it("creates the company, its owner and a first-password link", async () => {
    const res = await call("POST", "/v1/operator/organizations",
      newCompany("create", "olive@operator.test", { tradePack: "plumbing" }));
    expect(res.status).toBe(201);
    const body = await read(res);

    expect(Object.keys(body).sort()).toEqual(["created", "organizationId", "ownerSetupUrl", "ownerUserId"]);
    expect(body.created).toBe(true);
    expect(body.ownerSetupUrl).toMatch(new RegExp(`^${BASE}/welcome\\?token=`));

    const [org] = await raw<{ timezone: string; external_ref: string; primary_trade: string | null }[]>`
      select timezone, external_ref, primary_trade from public.organization where id = ${body.organizationId}`;
    expect(org!.timezone).toBe("America/Denver");
    expect(org!.external_ref).toBe(REF_PREFIX + "create");

    // Seeded the way the setup wizard seeds it.
    expect(org!.primary_trade).toBe("plumbing");
    const [items] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.price_book_item where organization_id = ${body.organizationId}`;
    expect(items!.n).toBeGreaterThan(0);

    const [member] = await raw<{ role: string }[]>`
      select role::text from public.membership
      where organization_id = ${body.organizationId} and user_id = ${body.ownerUserId}`;
    expect(member!.role).toBe("owner");
  });

  it("is idempotent on the external reference, with a fresh link that retires the old one", async () => {
    const first = await read(await call("POST", "/v1/operator/organizations",
      newCompany("idem", "ida@operator.test")));

    const again = await call("POST", "/v1/operator/organizations",
      newCompany("idem", "somebody-else@operator.test", { name: "A Different Name" }));
    expect(again.status).toBe(200);
    const second = await read(again);

    expect(second.created).toBe(false);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.ownerUserId).toBe(first.ownerUserId);

    const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
    expect(await setupTokens.peek(db(), tokenOf(first.ownerSetupUrl))).toBeNull();
    expect((await setupTokens.peek(db(), tokenOf(second.ownerSetupUrl)))?.email).toBe("ida@operator.test");

    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.organization where external_ref = ${REF_PREFIX + "idem"}`;
    expect(count!.n).toBe(1);
  });

  it("settles two concurrent creates on one company", async () => {
    const results = await Promise.all([1, 2, 3].map(() =>
      call("POST", "/v1/operator/organizations", newCompany("race", "rae@operator.test"))));
    const bodies = await Promise.all(results.map((r) => read(r)));
    expect(new Set(bodies.map((b) => b.organizationId)).size).toBe(1);
    expect(bodies.filter((b) => b.created === true)).toHaveLength(1);
  });

  it("spends a link once, and then sends the owner to sign in", async () => {
    const created = await read(await call("POST", "/v1/operator/organizations",
      newCompany("link", "lin@operator.test")));
    const token = new URL(created.ownerSetupUrl).searchParams.get("token")!;

    expect(await setupTokens.consume(db(), token, "scrypt$fake")).toBe(created.ownerUserId);
    expect(await setupTokens.consume(db(), token, "scrypt$other")).toBeNull();

    // The owner has a password now, so no link can set another one.
    const replay = await read(await call("POST", "/v1/operator/organizations",
      newCompany("link", "lin@operator.test")));
    expect(replay.ownerSetupUrl).toBe(`${BASE}/login`);
  });

  it("never issues a link that could reset an existing account's password", async () => {
    const first = await read(await call("POST", "/v1/operator/organizations",
      newCompany("existing-a", "eve@operator.test")));
    const token = new URL(first.ownerSetupUrl).searchParams.get("token")!;
    await setupTokens.consume(db(), token, "scrypt$eve");

    const second = await read(await call("POST", "/v1/operator/organizations",
      newCompany("existing-b", "EVE@operator.test")));
    expect(second.created).toBe(true);
    expect(second.ownerUserId).toBe(first.ownerUserId);
    expect(second.ownerSetupUrl).toBe(`${BASE}/login`);
  });

  it("refuses a timezone or trade pack it does not know, before writing anything", async () => {
    const zone = await call("POST", "/v1/operator/organizations",
      newCompany("bad-zone", "zed@operator.test", { timezone: "Mars/Olympus" }));
    expect(zone.status).toBe(422);
    const pack = await call("POST", "/v1/operator/organizations",
      newCompany("bad-pack", "zed@operator.test", { tradePack: "underwater-welding" }));
    expect(pack.status).toBe(422);
    const [n] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.organization
      where external_ref in (${REF_PREFIX + "bad-zone"}, ${REF_PREFIX + "bad-pack"})`;
    expect(n!.n).toBe(0);
  });

  it("names the operator on the company's own audit log", async () => {
    const created = await read(await call("POST", "/v1/operator/organizations",
      newCompany("audit", "aud@operator.test")));
    await call("GET", `/v1/operator/organizations/${created.organizationId}`);
    const rows = await raw<{ action: string; actor_agent_id: string; actor_user_id: string | null }[]>`
      select action, actor_agent_id, actor_user_id from public.audit_log
      where organization_id = ${created.organizationId} and action like 'operator.%'
      order by created_at`;
    expect(rows.map((r) => r.action)).toEqual(["operator.organization.created", "operator.organization.read"]);
    for (const row of rows) {
      expect(row.actor_agent_id).toBe("operator");
      expect(row.actor_user_id).toBeNull();
    }
  });
});

run("status and usage", () => {
  it("reads a company's status", async () => {
    const created = await read(await call("POST", "/v1/operator/organizations",
      newCompany("status", "sta@operator.test")));
    const res = await call("GET", `/v1/operator/organizations/${created.organizationId}`);
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Object.keys(body).sort()).toEqual(["createdAt", "name", "organizationId", "status"]);
    expect(body.status).toBe("active");
    expect(new Date(body.createdAt).getTime()).not.toBeNaN();
  });

  it("answers 404 for a company that does not exist, and for an id that is not one", async () => {
    expect((await call("GET", "/v1/operator/organizations/00000000-0000-4000-8000-000000000999")).status).toBe(404);
    expect((await call("GET", "/v1/operator/organizations/not-a-uuid")).status).toBe(404);
  });

  it("counts usage in the documented shape", async () => {
    const created = await read(await call("POST", "/v1/operator/organizations",
      newCompany("usage", "use@operator.test")));
    await sessionFor(created.ownerUserId, created.organizationId);

    const res = await call("GET", `/v1/operator/organizations/${created.organizationId}/usage`);
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Object.keys(body).sort()).toEqual([
      "activeUsers", "invoicesCreated", "jobsCreated", "messagesSent",
      "organizationId", "since", "storageBytes", "technicians",
    ]);
    for (const key of ["activeUsers", "invoicesCreated", "jobsCreated", "messagesSent", "storageBytes", "technicians"]) {
      expect(typeof body[key]).toBe("number");
    }
    expect(body.activeUsers).toBe(1);
    // Thirty days by default.
    const days = (Date.now() - new Date(body.since).getTime()) / 864e5;
    expect(Math.round(days)).toBe(30);

    const since = "2020-01-01T00:00:00.000Z";
    const explicit = await read(await call("GET",
      `/v1/operator/organizations/${created.organizationId}/usage?since=${since}`));
    expect(explicit.since).toBe(since);

    expect((await call("GET",
      `/v1/operator/organizations/${created.organizationId}/usage?since=yesterday-ish`)).status).toBe(422);
  });
});

run("suspending a company", () => {
  let organizationId = "";
  let ownerUserId = "";
  let sessionHash = "";
  let appToken = "";
  let grantToken = "";

  beforeAll(async () => {
    if (!url) return;
    const created = await read(await call("POST", "/v1/operator/organizations",
      newCompany("suspend", "sus@operator.test")));
    organizationId = created.organizationId;
    ownerUserId = created.ownerUserId;
    sessionHash = await sessionFor(ownerUserId, organizationId);

    const owner: ServiceContext = {
      actor: { userId: ownerUserId, organizationId, roles: ["owner"] as Actor["roles"] }, db: db(),
    };
    const app = await apps.install(owner, { name: "Partner", permissions: ["customer:read"] });
    appToken = (await apps.issueToken(owner, { appId: app.id })).token;

    grantToken = randomBytes(32).toString("base64url");
    await raw`insert into public.portal_grant (organization_id, scope, token_hash, expires_at)
              values (${organizationId}, 'customer',
                      ${createHash("sha256").update(grantToken).digest("hex")},
                      ${new Date(Date.now() + 864e5).toISOString()})`;
    await raw`update public.organization set slug = 'operator-suspend-co' where id = ${organizationId}`;
  });

  it("works before it is suspended", async () => {
    expect(await resolveSession(db(), sessionHash)).not.toBeNull();
    expect(await apps.resolveToken(db(), appToken)).not.toBeNull();
  });

  it("refuses the session, the app token, booking and the portal while suspended", async () => {
    const res = await call("POST", `/v1/operator/organizations/${organizationId}/suspend`,
      { reason: "card declined" });
    expect(res.status).toBe(200);
    expect((await read(res)).status).toBe("suspended");

    // A session: refused with a reason, not reported as signed out.
    await expect(resolveSession(db(), sessionHash)).rejects.toBeInstanceOf(OrganizationSuspendedError);

    // Over HTTP, with the cookie path and the token path, as the web app wires them.
    const viaSession = await dispatch(new Request(`${BASE}/api/v1/customers`), {
      db: db(), basePath: "/api",
      resolveSession: async () => {
        const auth = await authenticate(new Request(BASE), {
          db: db(), session: () => resolveSession(db(), sessionHash),
        });
        return auth?.ctx ?? null;
      },
    });
    expect(viaSession.status).toBe(403);
    expect((await read(viaSession)).code).toBe("organization_suspended");

    const tokenRequest = new Request(`${BASE}/api/v1/customers`, {
      headers: { authorization: `Bearer ${appToken}` },
    });
    const viaToken = await dispatch(tokenRequest, {
      db: db(), basePath: "/api",
      resolveSession: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
    });
    expect(viaToken.status).toBe(403);

    await expect(booking.listServices(db(), { organizationSlug: "operator-suspend-co" }))
      .rejects.toBeInstanceOf(OrganizationSuspendedError);
    await expect(portal.peek(db(), grantToken)).rejects.toBeInstanceOf(portal.InvalidGrantError);
  });

  it("is invisible to the worker", async () => {
    await raw`insert into public.domain_event (organization_id, sequence, name, entity_type, payload)
              values (${organizationId}, 1, 'job.created', 'job', '{}'::jsonb)`;
    const pending = await raw<{ organization_id: string }[]>`
      select organization_id from app.pending_event_organizations('workflow', 1000)`;
    expect(pending.map((r) => r.organization_id)).not.toContain(organizationId);
  });

  it("cannot be lifted by the company itself", async () => {
    const ctx: ServiceContext = {
      actor: { userId: ownerUserId, organizationId, roles: ["owner"] as Actor["roles"] }, db: db(),
    };
    await expect(inTenant(ctx, (tx) =>
      tx.execute(sql`update public.organization set suspended_at = null, external_ref = 'stolen'`),
    )).rejects.toThrow(/operator only/);
  });

  it("changes nothing else, and resuming restores every credential", async () => {
    const res = await call("POST", `/v1/operator/organizations/${organizationId}/resume`);
    expect(res.status).toBe(200);
    expect((await read(res)).status).toBe("active");

    expect((await resolveSession(db(), sessionHash))?.organizationId).toBe(organizationId);
    expect(await apps.resolveToken(db(), appToken)).not.toBeNull();
    expect((await portal.peek(db(), grantToken)).organizationId).toBe(organizationId);

    // And the event that waited is there for the worker again, unread.
    const pending = await raw<{ organization_id: string }[]>`
      select organization_id from app.pending_event_organizations('workflow', 1000)`;
    expect(pending.map((r) => r.organization_id)).toContain(organizationId);
  });
});

run("the request path cannot do what the operator does", () => {
  it("is refused the operator's functions", async () => {
    const ctx: ServiceContext = {
      actor: { userId: "00000000-0000-0000-0000-000000000000", organizationId: "00000000-0000-4000-8000-000000000001", roles: [] },
      db: db(),
    };
    await expect(inTenant(ctx, (tx) =>
      tx.execute(sql`select app.operator_organization_by_ref('anything')`),
    )).rejects.toThrow(/permission denied/);
    await expect(inTenant(ctx, (tx) =>
      tx.execute(sql`select app.issue_setup_token(gen_random_uuid(), 'x', now())`),
    )).rejects.toThrow(/permission denied/);
  });
});
