import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { can } from "@opentradesos/core";
import { routes } from "../src/contracts/index";
import { dispatch } from "../src/http/dispatch";
import { resolveSession } from "../src/services/session";
import { createDemoSession, setupDemo, demoEmail, DEMO_SESSIONS_PER_ADDRESS } from "../src/services/demo";
import { inTenant, DemoReadOnlyError, type ServiceContext } from "../src/services/context";
import * as customers from "../src/services/customers";
import * as portal from "../src/services/portal";
import * as booking from "../src/services/booking";
import * as referrals from "../src/services/referrals";
import * as websiteTracking from "../src/services/website-tracking";
import { usage } from "../src/services/operator";
import { drainAll } from "../src/services/workflow-worker";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * THE PUBLIC DEMO IS READ ONLY ON THE SERVER
 *
 * docs/self-hosting/demo.md promises one shared company anybody can click
 * around in and nobody can change. Every promise in it is asserted here
 * against a real database, because the failure is quiet and public at once:
 * a stranger's write in a company every other stranger then reads.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const DEMO_ORG = fixtureId("demo:org");
const OWNER = fixtureId("demo:owner");
const REAL_ORG = fixtureId("demo:real-org");
const REAL_OWNER = fixtureId("demo:real-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const ownerOf = (organizationId: string, userId: string): ServiceContext => ({
  actor: { userId, organizationId, roles: ["owner"] }, db: db(),
});

/** A fresh visitor address per call, so reruns never meet the last run's rate limit. */
const visitor = () => `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID()}`;

async function demoSession(): Promise<{ token: string; ctx: ServiceContext }> {
  const token = randomBytes(32).toString("base64url");
  const outcome = await createDemoSession(db(), { organizationId: DEMO_ORG, tokenHash: hash(token), ip: visitor() });
  expect(outcome).toBe("created");
  const session = await resolveSession(db(), hash(token));
  return { token, ctx: { actor: session!.actor, db: db() } };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  // The demo user from a previous run, so its address is free again.
  await raw`update public.organization set demo_user_id = null where id = ${DEMO_ORG}`;
  await raw`delete from public."user" where email = ${demoEmail(DEMO_ORG)}`;
  await seedOrg(raw, { organizationId: DEMO_ORG, userId: OWNER, name: "Demo Co", slug: "demo-co" });
  await raw`update public.organization set setup_completed_at = now() where id = ${DEMO_ORG}`;
  await seedOrg(raw, { organizationId: REAL_ORG, userId: REAL_OWNER, name: "Real Co", slug: "real-co" });
  await setupDemo(db(), DEMO_ORG);
});

afterAll(async () => {
  if (!url) return;
  await raw`update public.organization set demo_user_id = null where id = ${DEMO_ORG}`;
  await raw`delete from public.session where user_id in (select id from public."user" where email = ${demoEmail(DEMO_ORG)})`;
  await resetOrg(raw, DEMO_ORG);
  await resetOrg(raw, REAL_ORG);
  await raw`delete from public."user" where email = ${demoEmail(DEMO_ORG)}`;
  await raw.end();
});

run("setting a company up as the demo", () => {
  it("is idempotent, and deletes nothing in it or anywhere else", async () => {
    /**
     * Counted in the two companies this file owns, not across the table:
     * every other test file seeds members in parallel, so a global count
     * moves under this test for reasons that have nothing to do with it.
     */
    const count = () => raw<{ n: number }[]>`
      select count(*)::int as n from public.membership
       where organization_id in (${DEMO_ORG}, ${REAL_ORG})`;
    const before = await count();
    const again = await setupDemo(db(), DEMO_ORG);
    expect(again.changed).toBe(false);
    const after = await count();
    expect(after[0]!.n).toBe(before[0]!.n);
    const [membership] = await raw<{ role: string }[]>`
      select m.role::text as role from public.membership m
      join public."user" u on u.id = m.user_id
      where m.organization_id = ${DEMO_ORG} and u.email = ${demoEmail(DEMO_ORG)}`;
    expect(membership?.role).toBe("readonly");
  });

  it("puts the membership back if somebody widened it", async () => {
    const [demo] = await raw<{ demo_user_id: string }[]>`select demo_user_id from public.organization where id = ${DEMO_ORG}`;
    await raw`update public.membership set role = 'owner' where user_id = ${demo!.demo_user_id} and organization_id = ${DEMO_ORG}`;
    expect((await setupDemo(db(), DEMO_ORG)).changed).toBe(true);
    const [row] = await raw<{ role: string }[]>`
      select role::text as role from public.membership where user_id = ${demo!.demo_user_id} and organization_id = ${DEMO_ORG}`;
    expect(row?.role).toBe("readonly");
  });

  it("cannot be done by a tenant to its own company", async () => {
    await expect(inTenant(ownerOf(REAL_ORG, REAL_OWNER), (tx) => tx.execute(
      sql`update public.organization set demo_user_id = ${REAL_OWNER}::uuid where id = ${REAL_ORG}::uuid`,
    ))).rejects.toThrow(/written by the operator only/);
  });
});

run("GET /demo's session", () => {
  it("is refused for a company that is not the demo, so a mistaken id publishes nothing", async () => {
    for (const organizationId of [REAL_ORG, randomUUID(), "not-a-uuid"]) {
      expect(await createDemoSession(db(), { organizationId, tokenHash: hash(randomUUID()), ip: visitor() }))
        .toBe("not_demo");
    }
  });

  it("is the readonly role, read only, in the demo company, for two hours", async () => {
    const token = randomBytes(32).toString("base64url");
    await createDemoSession(db(), { organizationId: DEMO_ORG, tokenHash: hash(token), ip: visitor() });
    const session = await resolveSession(db(), hash(token));
    expect(session?.demo).toBe(true);
    expect(session?.organizationId).toBe(DEMO_ORG);
    expect(session?.actor.roles).toEqual(["readonly"]);
    expect(session?.actor.readOnly).toBe(true);
    expect(can(session!.actor, "customer:read")).toBe(true);
    expect(can(session!.actor, "customer:write")).toBe(false);

    const [row] = await raw<{ hours: number }[]>`
      select extract(epoch from (expires_at - now())) / 3600 as hours from public.session where token_hash = ${hash(token)}`;
    expect(Number(row!.hours)).toBeGreaterThan(1.9);
    expect(Number(row!.hours)).toBeLessThanOrEqual(2);
  });

  it("stays read only whatever is done to the demo user's membership", async () => {
    const { ctx } = await demoSession();
    await raw`update public.membership set role = 'owner', grants = '["user:invite"]'::jsonb
              where user_id = ${ctx.actor.userId} and organization_id = ${DEMO_ORG}`;
    try {
      const token = randomBytes(32).toString("base64url");
      await raw`insert into public.session (user_id, token_hash, active_organization_id, expires_at)
                values (${ctx.actor.userId}, ${hash(token)}, ${DEMO_ORG}, now() + interval '1 hour')`;
      const session = await resolveSession(db(), hash(token));
      expect(session?.demo).toBe(true);
      expect(session?.actor.roles).toEqual(["readonly"]);
      expect(can(session!.actor, "user:invite")).toBe(false);
    } finally {
      await setupDemo(db(), DEMO_ORG);
    }
  });

  it("is limited per address, in the database", async () => {
    const ip = visitor();
    const outcomes: string[] = [];
    for (let i = 0; i <= DEMO_SESSIONS_PER_ADDRESS; i += 1) {
      outcomes.push(await createDemoSession(db(), { organizationId: DEMO_ORG, tokenHash: hash(randomUUID()), ip }));
    }
    expect(outcomes.slice(0, DEMO_SESSIONS_PER_ADDRESS).every((o) => o === "created")).toBe(true);
    expect(outcomes.at(-1)).toBe("limited");
    // Another address is unaffected.
    expect(await createDemoSession(db(), { organizationId: DEMO_ORG, tokenHash: hash(randomUUID()), ip: visitor() }))
      .toBe("created");
    // And the table keeps a hash, never the address.
    const kept = await raw<{ n: number }[]>`select count(*)::int as n from public.demo_visit where ip_hash = ${ip}`;
    expect(kept[0]!.n).toBe(0);
  });
});

run("the demo session cannot write", () => {
  it("refuses EVERY route that is not a GET, with a 403, before anything else runs", async () => {
    const { ctx } = await demoSession();
    const sessionRoutes = Object.entries(routes)
      .map(([name, route]) => ({ name, ...(route as { method: string; path: string; authorization?: string }) }))
      .filter((r) => (r.authorization ?? "session") === "session" && r.method !== "get");
    expect(sessionRoutes.length).toBeGreaterThan(150);

    const answered: string[] = [];
    for (const route of sessionRoutes) {
      const path = route.path.replace(/\{[^}]+\}/g, () => randomUUID());
      const response = await dispatch(
        new Request(`https://ots.example.test/api${path}`, {
          method: route.method.toUpperCase(),
          headers: { "content-type": "application/json" },
          ...(route.method === "delete" ? {} : { body: "{}" }),
        }),
        { db: db(), basePath: "/api", resolveSession: async () => ({ ...ctx }) },
      );
      const body = await response.json() as { code?: string };
      if (response.status !== 403 || body.code !== "demo_read_only") {
        answered.push(`${route.method.toUpperCase()} ${route.path} (${route.name}): ${response.status}`);
      }
    }
    expect(answered).toEqual([]);
  });

  it("serves a GET", async () => {
    const { ctx } = await demoSession();
    const response = await dispatch(
      new Request("https://ots.example.test/api/v1/customers"),
      { db: db(), basePath: "/api", resolveSession: async () => ({ ...ctx }) },
    );
    expect(response.status).toBe(200);
  });

  it("is refused by the service's permission check", async () => {
    const { ctx } = await demoSession();
    await expect(customers.create(ctx, {
      type: "residential", name: "Should Not Exist", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).rejects.toThrow(/Missing permission/);
  });

  it("is refused by Postgres when a write asks for no permission at all", async () => {
    const { ctx } = await demoSession();
    await expect(inTenant(ctx, (tx) => tx.execute(
      sql`insert into public.customer (organization_id, type, name) values (${DEMO_ORG}::uuid, 'residential', 'Nope')`,
    ))).rejects.toBeInstanceOf(DemoReadOnlyError);
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.customer where organization_id = ${DEMO_ORG} and name = 'Nope'`;
    expect(count!.n).toBe(0);
  });
});

run("the demo company's customer side and background work", () => {
  it("its portal links open, and approve and pay nothing", async () => {
    const customer = await customers.create(ownerOf(DEMO_ORG, OWNER), {
      type: "residential", name: "Pat Portal", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const { token } = await inTenant(ownerOf(DEMO_ORG, OWNER), (tx) => portal.mintGrant(tx, {
      organizationId: DEMO_ORG, customerId: customer.id, scope: "customer", expiresInDays: 1,
    }));
    await expect(portal.peek(db(), token)).resolves.toMatchObject({ organizationId: DEMO_ORG });
    await expect(portal.consume(db(), token)).rejects.toBeInstanceOf(DemoReadOnlyError);
    const [grant] = await raw<{ use_count: number }[]>`select use_count from public.portal_grant where token_hash = ${hash(token)}`;
    expect(grant!.use_count).toBe(0);
  });

  it("opens a customer, whose referral code was minted when the demo was set up", async () => {
    /**
     * The customer page mints a referral code on first view, a write the
     * demo's read only session cannot make. Setting the demo up mints them
     * all, so the page reads and the demo writes nothing.
     */
    const customer = await customers.create(ownerOf(DEMO_ORG, OWNER), {
      type: "residential", name: "Rae Referral", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    await raw`update public.customer set referral_code = null where id = ${customer.id}`;
    const { ctx } = await demoSession();
    await expect(referrals.forCustomer(ctx, customer.id)).rejects.toBeInstanceOf(DemoReadOnlyError);

    expect((await setupDemo(db(), DEMO_ORG)).changed).toBe(true);
    const mine = await referrals.forCustomer(ctx, customer.id);
    expect(mine.code).toMatch(/\S/);
    expect((await setupDemo(db(), DEMO_ORG)).changed).toBe(false);
  });

  it("its website snippet records no visit", async () => {
    await expect(websiteTracking.companyFor(db(), "demo-co")).rejects.toBeInstanceOf(DemoReadOnlyError);
    await expect(websiteTracking.companyFor(db(), "real-co")).resolves.toMatchObject({ slug: "real-co" });
  });

  it("its booking page books nothing", async () => {
    await expect(booking.createRequest(db(), {
      organizationSlug: "demo-co", bookableServiceId: randomUUID(), windowStart: new Date().toISOString(),
      name: "Stranger", phone: "+15125550100",
    } as never)).rejects.toBeInstanceOf(DemoReadOnlyError);
  });

  it("the worker finds no work for it", async () => {
    await raw`insert into public.domain_event (organization_id, sequence, name, entity_type, payload)
              values (${DEMO_ORG}, 1, 'job.created', 'job', '{}'::jsonb) on conflict do nothing`;
    const pending = await raw<{ organization_id: string }[]>`
      select organization_id from app.pending_event_organizations('workflow', 100000)`;
    expect(pending.map((r) => r.organization_id)).not.toContain(DEMO_ORG);
    expect(await drainAll(db(), { only: [DEMO_ORG] })).toEqual([]);
  });

  it("its visitors are not active users in the operator's usage report", async () => {
    await demoSession();
    const report = await usage(db(), DEMO_ORG, new Date(Date.now() - 864e5));
    expect(report.activeUsers).toBe(0);
  });
});
