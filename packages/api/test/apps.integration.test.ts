import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { permissionsFor } from "@opentradesos/core";
import * as apps from "../src/services/apps";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as properties from "../src/services/properties";
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
