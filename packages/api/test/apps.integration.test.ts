import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { permissionsFor } from "@opentradesos/core";
import * as apps from "../src/services/apps";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as booking from "../src/services/booking";
import * as properties from "../src/services/properties";
import { authenticate, attributingApp } from "../src/http/authenticate";
import { dispatch } from "../src/http/dispatch";
import { routes } from "../src/contracts";
import type { ResolvedSession } from "../src/services/session";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A THIRD PARTY, ACTING
 *
 * The point of this file is that an app is not a special case. It gets an
 * `Actor`, and every permission check and scope filter already written
 * applies to it unchanged, which is why there is no parallel authorization
 * system here to test.
 *
 * What IS specific is the two rules that decide whether the actor should
 * exist at all: you cannot grant what you do not hold, and revocation means
 * now.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("app:org");
const USER = fixtureId("app:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "App Co", slug: "app-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Ada App", phone: "+15125550150",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "5 App Lane", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
  await jobs.create(owner(), {
    customerId, propertyId, summary: "App job", tags: [], customFields: {},
  });
});

let serviceId = "";
let windowId = "";

beforeAll(async () => {
  if (!url) return;
  const [jt] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, capacity_model)
    values (${ORG}, 'Tune up', 'technician_dispatch') returning id`;
  const [svc] = await raw<{ id: string }[]>`
    insert into public.bookable_service
      (organization_id, job_type_id, public_name, display_price, min_notice_hours,
       max_advance_days, max_per_window)
    values (${ORG}, ${jt!.id}, 'Seasonal tune up', 149.0000, 0, 60, 5) returning id`;
  serviceId = svc!.id;

  const [w] = await raw<{ id: string }[]>`
    insert into public.arrival_window
      (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, '8am to 12pm', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
  windowId = w!.id;

  for (let d = 0; d < 7; d += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${d}, '07:00', '18:00')`;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.app_token where organization_id = ${ORG}`;
  await raw`delete from public.connected_app where organization_id = ${ORG}`;
});

const install = () => apps.install(owner(), {
  name: "Neighbrium", publisher: "Neighbrium, Inc.",
  permissions: ["booking:read", "customer:read"],
});

run("installing an app", () => {
  it("records who approved it and what it asked for", async () => {
    const app = await install();
    // Not "what could this app do" but "who decided it could". A list of API
    // keys with no provenance cannot answer that.
    expect(app.approvedByUserId).toBe(USER);
    expect(app.permissions).toEqual(["booking:read", "customer:read"]);
    expect(app.status).toBe("active");
  });

  it("refuses a permission the installer does not hold", async () => {
    const officeManager: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["office_manager"] as Actor["roles"],
        // Given the permission to touch integrations, so this isolates the
        // authority check from the permission check.
        grants: ["integration:write"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(apps.install(officeManager, {
      name: "Greedy", permissions: ["ledger:read", "customer:read"],
    })).rejects.toThrow(/ledger:read/);
  });

  it("refuses a scope wider than the installer's own", async () => {
    const restricted: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["technician"] as Actor["roles"],
        grants: ["integration:write", "job:read"] as NonNullable<Actor["grants"]>,
        scopeOverrides: { job: "own" },
      },
      db: db(),
    };
    await expect(apps.install(restricted, {
      name: "Wide", permissions: ["job:read"], scopes: { job: "all" },
    })).rejects.toThrow(/job/);
  });

  it("refuses a permission key that is not in the catalogue", async () => {
    // Dropping it silently produces an app that looks correctly limited on
    // the consent screen and is limited by accident.
    await expect(apps.install(owner(), {
      name: "Typo", permissions: ["booking:raed"],
    })).rejects.toThrow(/Unknown permissions/);
  });

  it("checks the result of an edit, not the change", async () => {
    // Editing an app you may edit into one you may not have installed is the
    // same escalation.
    const app = await install();
    const officeManager: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["office_manager"] as Actor["roles"],
        grants: ["integration:write"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(apps.update(officeManager, {
      id: app.id, permissions: ["ledger:read"],
    })).rejects.toThrow(/ledger:read/);
  });
});

run("the actor an app token produces", () => {
  it("holds exactly what was approved, and nothing from the installer", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });

    const resolved = await apps.resolveToken(db(), token);
    expect(resolved).not.toBeNull();

    const held = permissionsFor(resolved!.actor);
    expect(held.has("booking:read")).toBe(true);
    expect(held.has("customer:read")).toBe(true);
    // The owner installed it. The app must not act as the owner.
    expect(held.has("ledger:read")).toBe(false);
    expect(held.has("invoice:void")).toBe(false);
    expect(resolved!.actor.roles).toEqual([]);
    expect(resolved!.actor.technicianId).toBeUndefined();
  });

  it("names itself, so an audit entry says which app did it", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    const resolved = await apps.resolveToken(db(), token);
    expect(resolved!.actor.agentId).toBe(`app:${app.id}`);
  });

  it("reads nothing when a permission was granted with no scope", async () => {
    /**
     * `customer:read` on its own is not "read the customer book".
     *
     * An actor with no roles falls to the narrowest scope, and an app is not
     * a technician, so "own" matches nothing at all. That is the right way
     * round to fail, and it means an app's reach has to be stated rather
     * than implied: the consent screen says "read ALL customers" because
     * that is what the grant actually has to say.
     */
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    const resolved = await apps.resolveToken(db(), token);

    const page = await customers.list(
      { actor: resolved!.actor, db: db() },
      { limit: 10, includeInactive: false },
    );
    expect(page.data).toHaveLength(0);
  });

  it("goes through the same service layer as anybody else", async () => {
    // The whole argument for this design: no parallel path to get wrong.
    const app = await apps.install(owner(), {
      name: "Neighbrium", permissions: ["booking:read", "customer:read"],
      scopes: { customer: "all" },
    });
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    const resolved = await apps.resolveToken(db(), token);

    const page = await customers.list(
      { actor: resolved!.actor, db: db() },
      { limit: 10, includeInactive: false },
    );
    expect(page.data.length).toBeGreaterThan(0);

    // And is refused what it was not given, by the ordinary permission check.
    await expect(
      jobs.list({ actor: resolved!.actor, db: db() }, { limit: 10 }),
    ).rejects.toThrow(/job:read/);
  });

  it("resolves to nothing for a token that was never issued", async () => {
    expect(await apps.resolveToken(db(), "ots_not-a-real-token")).toBeNull();
  });
});

run("revocation means now", () => {
  it("stops the token the moment the app is revoked", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    expect(await apps.resolveToken(db(), token)).not.toBeNull();

    await apps.revoke(owner(), { id: app.id, reason: "No longer used" });

    // Not "at next refresh". An operator who revokes at 4pm means 4pm.
    expect(await apps.resolveToken(db(), token)).toBeNull();
  });

  it("stops a token whose app was disabled without touching the token", async () => {
    /**
     * `revoke` turns the tokens off as well, which is belt and braces and
     * means the first test above passes with the app status check removed
     * entirely. This is the condition on its own: an app turned off by any
     * other path, including a future one that only sets the status, must stop
     * resolving. Both conditions are in the SQL rather than in TypeScript
     * precisely so a caller cannot skip one.
     */
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    await raw`update public.connected_app set status = 'revoked' where id = ${app.id}`;

    expect(await apps.resolveToken(db(), token)).toBeNull();
  });

  it("stops one token without stopping the other", async () => {
    // Rotation without downtime needs two valid at once.
    const app = await install();
    const a = await apps.issueToken(owner(), { appId: app.id, label: "old" });
    const b = await apps.issueToken(owner(), { appId: app.id, label: "new" });

    await apps.revokeToken(owner(), { tokenId: a.id });

    expect(await apps.resolveToken(db(), a.token)).toBeNull();
    expect(await apps.resolveToken(db(), b.token)).not.toBeNull();
  });

  it("refuses a token that has expired", async () => {
    // A partner holding a permanent credential is a permanent liability, so
    // the column is not nullable and the check is in the resolver.
    const app = await install();
    const { token, id } = await apps.issueToken(owner(), { appId: app.id });
    await raw`update public.app_token set expires_at = now() - interval '1 hour' where id = ${id}`;
    expect(await apps.resolveToken(db(), token)).toBeNull();
  });

  it("keeps the record after revoking, so what it did stays attributable", async () => {
    const app = await install();
    await apps.revoke(owner(), { id: app.id });
    const listed = await apps.list(owner());
    expect(listed.find((a) => a.id === app.id)?.status).toBe("revoked");
  });

  it("will not issue a token for a revoked app", async () => {
    const app = await install();
    await apps.revoke(owner(), { id: app.id });
    await expect(apps.issueToken(owner(), { appId: app.id })).rejects.toThrow(/not active/);
  });
});

run("the credential itself", () => {
  it("is never recoverable from the database", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });

    const rows = await raw<{ token_hash: string; hint: string | null }[]>`
      select token_hash, hint from public.app_token where organization_id = ${ORG}`;

    // A credential a support engineer can read out of a table is a credential
    // the company does not really control.
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toBe(apps.hashToken(token));
    // The hint is for telling two tokens apart while rotating, and is not
    // enough to use.
    expect(token.endsWith(rows[0]!.hint!)).toBe(true);
    expect(rows[0]!.hint!.length).toBeLessThan(8);
  });
});

run("authenticating over HTTP", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example.test/api/v1/customers", { headers });

  /** A signed in person, for the cases where both credentials are present. */
  const signedIn = async (): Promise<ResolvedSession> => ({
    actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] },
    userId: USER, email: "owner@app-co.test", name: null,
    organizationId: ORG, organizationName: "App Co", organizationSlug: "app-co",
    organizationTimezone: "America/Chicago", setupCompleted: true,
  });

  it("accepts a bearer token and acts as the app", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });

    const result = await authenticate(
      request({ authorization: `Bearer ${token}` }),
      { db: db(), session: signedIn },
    );

    expect(result?.appId).toBe(app.id);
    expect(result?.ctx.actor.agentId).toBe(`app:${app.id}`);
    // So every audit entry this request causes names the app.
    expect(result?.ctx.agentId).toBe(`app:${app.id}`);
  });

  it("prefers the token over a cookie that happens to be present", async () => {
    /**
     * A browser attaches cookies whether or not the caller meant to use them.
     * If the cookie won, a partner's request would silently run as whichever
     * user was signed in, with their permissions instead of the app's, and
     * the audit trail would name a person who did nothing.
     */
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });

    const result = await authenticate(
      request({ authorization: `Bearer ${token}` }),
      { db: db(), session: signedIn },
    );
    expect(result?.ctx.actor.roles).toEqual([]);
    expect(result?.ctx.actor.userId).not.toBe(USER);
  });

  it("refuses a rejected token rather than falling back to the cookie", async () => {
    // Falling through would turn a revoked app's request into one made as the
    // operator signed in on the same machine.
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    await apps.revoke(owner(), { id: app.id });

    const result = await authenticate(
      request({ authorization: `Bearer ${token}` }),
      { db: db(), session: signedIn },
    );
    /**
     * Asserted as a boolean, not with `toBeNull()` on the result.
     *
     * A `ServiceContext` carries the database client, and when this assertion
     * fails vitest tries to pretty-print it: the reporter recurses through
     * the whole connection pool and the actual failure is buried under two
     * hundred lines of stack from the formatter. A test whose failure cannot
     * be read is most of the way to a test nobody trusts.
     */
    expect(result === null).toBe(true);
  });

  it("falls back to the cookie when no token is presented", async () => {
    const result = await authenticate(request(), { db: db(), session: signedIn });
    expect(result?.ctx.actor.userId).toBe(USER);
    expect(result?.appId).toBeUndefined();
  });

  it("ignores an Authorization header that is not one of ours", async () => {
    // Basic auth from a misconfigured proxy must not read as a refusal.
    const result = await authenticate(
      request({ authorization: "Basic dXNlcjpwYXNz" }),
      { db: db(), session: signedIn },
    );
    expect(result?.ctx.actor.userId).toBe(USER);
  });

  it("records that the app was used", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    await authenticate(request({ authorization: `Bearer ${token}` }), { db: db(), session: signedIn });

    /**
     * `touch` is deliberately not awaited into the request, so this waits for
     * it rather than asserting on a race.
     *
     * A fixed sleep was the first version and it is the same race with a
     * longer fuse: fifty milliseconds is enough until the database is cold,
     * and then the whole suite goes red on a test that passes on its own.
     * Polling waits as long as it takes and still fails if it never happens.
     */
    let lastUsed: Date | null = null;
    for (let attempt = 0; attempt < 100 && lastUsed === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [row] = await raw<{ last_used_at: Date | null }[]>`
        select last_used_at from public.connected_app where id = ${app.id}`;
      lastUsed = row?.last_used_at ?? null;
    }
    expect(lastUsed).not.toBeNull();
  });
});

run("attribution on an open route", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example.test/api/v1/booking/requests", { method: "POST", headers });

  it("names the app that sent the caller", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    expect(await attributingApp(request({ authorization: `Bearer ${token}` }), db())).toBe(app.id);
  });

  it("is absent rather than refused when there is no token", async () => {
    // Booking is open to anybody with the company slug. A token attributes,
    // it does not admit.
    expect(await attributingApp(request(), db())).toBeUndefined();
  });

  it("is absent rather than refused when the token is dead", async () => {
    // A partner whose token expired should still be able to send work rather
    // than silently stop.
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    await apps.revoke(owner(), { id: app.id });
    expect(await attributingApp(request({ authorization: `Bearer ${token}` }), db())).toBeUndefined();
  });
});

run("a partner sending work, end to end", () => {
  const book = (meta?: { connectedAppId?: string | undefined }) => booking.createRequest(
    db(),
    {
      organizationSlug: "app-co", bookableServiceId: serviceId,
      requestedDate: new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10),
      arrivalWindowId: windowId,
      contactName: "Nia Partner", contactPhone: "5125550161",
      addressLine1: "6 Partner Row", city: "Austin", state: "TX", postalCode: "78702",
      intakeAnswers: {}, utm: {},
    },
    meta,
  );

  it("records which app the booking came through", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });

    const appId = await attributingApp(
      new Request("https://example.test/", {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      }),
      db(),
    );
    const { request } = await book({ connectedAppId: appId });

    const [row] = await raw<{ connected_app_id: string | null }[]>`
      select connected_app_id from public.booking_request where id = ${request.id}`;
    // Without this a partner's bookings are indistinguishable from the
    // widget's, and an operator deciding whether the channel is worth keeping
    // has nothing to decide with.
    expect(row!.connected_app_id).toBe(app.id);
  });

  it("leaves it null for a booking off the widget", async () => {
    const { request } = await book();
    const [row] = await raw<{ connected_app_id: string | null }[]>`
      select connected_app_id from public.booking_request where id = ${request.id}`;
    expect(row!.connected_app_id).toBeNull();
  });
});

/* ================================================== asking what it may do */

run("an app asking what its token may do", () => {
  /**
   * The migration loader found out whether it held `data:import` by posting
   * a deliberately invalid back-dated invoice and reading 403 against 422: a
   * write probe against a live company's books. This is the read it uses
   * instead, served through the same dispatcher and credential as every
   * other route.
   */
  const ask = async (headers: Record<string, string>, session: ServiceContext | null = null) => {
    const response = await dispatch(
      new Request("http://localhost/api/v1/apps/me", { headers }),
      {
        db: db(),
        basePath: "/api",
        resolveSession: async (req) => {
          const authenticated = await authenticate(req, {
            db: db(), session: async () => session as unknown as ResolvedSession | null,
          });
          return authenticated?.ctx ?? null;
        },
      },
    );
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it("names the app, its permissions and the scope it holds on every resource", async () => {
    const app = await apps.install(owner(), {
      name: "Migrator", publisher: "Migrator Ltd",
      permissions: ["customer:read", "data:import", "job:read"],
      scopes: { customer: "all" },
    });
    const { token } = await apps.issueToken(owner(), { appId: app.id });

    const { status, body } = await ask({ authorization: `Bearer ${token}` });
    expect(status).toBe(200);
    expect(routes.getAppSelf.output.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      appId: app.id, name: "Migrator", publisher: "Migrator Ltd", organizationId: ORG,
      permissions: ["customer:read", "data:import", "job:read"],
    });
    /** Stated where the install stated it, and `own` (matching nothing) everywhere else. */
    expect(body.scopes).toMatchObject({ customer: "all", job: "own", invoice: "own" });
  });

  it("lets the loader see it lacks data:import without writing anything", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    const { body } = await ask({ authorization: `Bearer ${token}` });
    expect(body.permissions).not.toContain("data:import");
  });

  it("answers a person with a 404, because no app is behind a session", async () => {
    const { status } = await ask({}, owner());
    expect(status).toBe(404);
  });

  it("refuses a revoked token like any other route", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id });
    await apps.revoke(owner(), { id: app.id });
    const { status } = await ask({ authorization: `Bearer ${token}` });
    expect(status).toBe(401);
  });
});

/**
 * THE OPERATOR'S SIDE, WHICH HAD NO ROUTES AND NO SCREEN
 *
 * Every test above drives the service directly, which is how this module got to
 * be complete and unreachable: install, revoke, issue and revoke a token were all
 * written, guarded and tested, and a company had no way to let an app in. These
 * are about the surface, and about the three claims it makes that were not true
 * when the routes were added: a retried install installs once, a second revoke
 * succeeds, and `live` means somebody can actually call us.
 */
run("the list an operator reads", () => {
  it("shows a credential by label and last four, and never the token", async () => {
    const app = await install();
    const { token } = await apps.issueToken(owner(), { appId: app.id, label: "nightly sync" });

    const [view] = await apps.list(owner());
    expect(view?.name).toBe("Neighbrium");
    expect(view?.tokens).toHaveLength(1);
    expect(view?.tokens[0]?.label).toBe("nightly sync");
    expect(view?.tokens[0]?.hint).toBe(token.slice(-4));
    /**
     * The property the whole module is built for. Serialise the view and the
     * token must not be in it anywhere: not under a key somebody forgot, not
     * inside the hint, not in a nested row.
     */
    expect(JSON.stringify(view)).not.toContain(token);
  });

  it("says an app with no token is not live, though its status is active", async () => {
    /**
     * `status` and reachability are different facts and this is the one that
     * misleads: an app approved and never issued a credential reads as connected
     * on a screen that shows the status alone.
     */
    const app = await install();
    const [view] = await apps.list(owner());
    expect(view?.status).toBe("active");
    expect(view?.live).toBe(false);
    expect(app.status).toBe("active");
  });

  it("says an app whose only token has lapsed is not live", async () => {
    const app = await install();
    const { id } = await apps.issueToken(owner(), { appId: app.id });
    await raw`update public.app_token set expires_at = now() - interval '1 day' where id = ${id}`;

    const [view] = await apps.list(owner());
    expect(view?.tokens[0]?.expired).toBe(true);
    expect(view?.tokens[0]?.revokedAt).toBeNull();
    /** Expiry moves on its own, which is why this is computed and not stored. */
    expect(view?.live).toBe(false);
  });

  it("says an app is live once it holds one token that is neither revoked nor lapsed", async () => {
    const app = await install();
    await apps.issueToken(owner(), { appId: app.id });
    const [view] = await apps.list(owner());
    expect(view?.live).toBe(true);
  });

  it("keeps a revoked app in the list with its reason", async () => {
    const app = await install();
    await apps.revoke(owner(), { id: app.id, reason: "Contract ended" });
    const [view] = await apps.list(owner());
    expect(view?.status).toBe("revoked");
    expect(view?.revokedReason).toBe("Contract ended");
    expect(view?.live).toBe(false);
  });
});

run("retrying a write", () => {
  it("installs once for one idempotency key", async () => {
    const key = `install-${Date.now()}`;
    const ctx = { ...owner(), idempotencyKey: key };
    const first = await apps.install(ctx, { name: "Retried", permissions: ["customer:read"] });
    const second = await apps.install(ctx, { name: "Retried", permissions: ["customer:read"] });
    expect(second.id).toBe(first.id);
    expect(await apps.list(owner())).toHaveLength(1);
  });

  it("installs twice under two keys, because those are two decisions", async () => {
    const a = await apps.install(
      { ...owner(), idempotencyKey: "one" }, { name: "A", permissions: ["customer:read"] },
    );
    const b = await apps.install(
      { ...owner(), idempotencyKey: "two" }, { name: "B", permissions: ["customer:read"] },
    );
    expect(b.id).not.toBe(a.id);
  });

  it("succeeds on a second revoke rather than reporting a failure", async () => {
    /**
     * A retry after a lost response is the common case. Refusing it is how an
     * operator concludes an app they revoked is still live.
     */
    const app = await install();
    const first = await apps.revoke(owner(), { id: app.id, reason: "Leaked" });
    const again = await apps.revoke(owner(), { id: app.id });
    expect(again.status).toBe("revoked");
    /** And it did not move when it was turned off, or lose why. */
    expect(again.revokedAt?.toISOString()).toBe(first.revokedAt?.toISOString());
    expect(again.revokedReason).toBe("Leaked");
  });

  it("succeeds on a second token revoke, and still 404s for a token that never existed", async () => {
    const app = await install();
    const { id } = await apps.issueToken(owner(), { appId: app.id });
    await apps.revokeToken(owner(), { tokenId: id });
    await expect(apps.revokeToken(owner(), { tokenId: id })).resolves.toBeUndefined();
    await expect(apps.revokeToken(owner(), { tokenId: fixtureId("app:nothing") }))
      .rejects.toThrow(/Token/);
  });

  it("leaves a second token on a retried issue, because the response is a secret", async () => {
    /**
     * The one write here that is not idempotent, and `contracts.test.ts` carries
     * the reason: only the hash is stored, so a replay has nothing to hand back.
     * The cost is a second token the operator can see and revoke, which is a far
     * better one than storing a plaintext token so a replay could return it.
     */
    const app = await install();
    const ctx = { ...owner(), idempotencyKey: "same-key" };
    const first = await apps.issueToken(ctx, { appId: app.id, label: "one" });
    const second = await apps.issueToken(ctx, { appId: app.id, label: "one" });
    expect(second.token).not.toBe(first.token);
    const [view] = await apps.list(owner());
    expect(view?.tokens).toHaveLength(2);
  });
});
