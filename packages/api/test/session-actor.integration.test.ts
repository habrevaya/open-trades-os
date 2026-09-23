import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { resolveSession } from "../src/services/session";
import * as roles from "../src/services/roles";
import type { ServiceContext } from "../src/services/context";
import { permissionsFor, type Actor } from "@opentradesos/core";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE ACTOR A REAL REQUEST CARRIES
 *
 * Every scope test in this repository builds its actor by hand, with
 * `technicianId` and `crewIds` filled in, and then asserts that the filter
 * narrows correctly. All of them passed while the signed-in path produced an
 * actor with neither field, because the two were never compared.
 *
 * The scope filters fail closed, so the symptom was not a leak: it was a
 * technician signing in and seeing an empty job list, which reads as "no work
 * assigned" rather than as a bug. The opposite mistake would have been worse
 * and this one is still wrong.
 *
 * So this file resolves a session the way the web app does, through the same
 * function, and asserts on what comes back rather than on what a test
 * constructed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("sa:org");
const OWNER_USER = fixtureId("sa:owner");
const TECH_USER = fixtureId("sa:tech");
const MATE_USER = fixtureId("sa:mate");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER_USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let mineId = "";
let theirsId = "";
let techToken = "";

/** A member, their technician record, and a live session token. */
async function member(userId: string, role: string, email: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email) values (${userId}, ${email})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}::member_role) returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${email}) returning id`;

  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await raw`select app.create_session(${userId}::uuid, ${hash}, ${ORG}::uuid,
            ${new Date(Date.now() + 864e5).toISOString()}::timestamptz)`;
  return { membershipId: m!.id, technicianId: t!.id, token };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER_USER, name: "Session Co", slug: "session-co" });

  const tech = await member(TECH_USER, "technician", "tech@session.test");
  const mate = await member(MATE_USER, "technician", "mate@session.test");
  techToken = tech.token;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Sam Session", phone: "+15125550170",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "3 Session Row", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });

  const mine = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Mine", tags: [], customFields: {},
  });
  const theirs = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "Theirs", tags: [], customFields: {},
  });
  mineId = mine.id;
  theirsId = theirs.id;

  // One visit each, assigned to a different technician. This is what "own"
  // means for a job: a visit on it assigned to you.
  for (const [jobId, technicianId] of [[mine.id, tech.technicianId], [theirs.id, mate.technicianId]] as const) {
    const [visit] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, status, window_start)
      values (${ORG}, ${jobId}, 'scheduled', now()) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
              values (${ORG}, ${visit!.id}, ${technicianId})`;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

/**
 * postgres.js infers a jsonb parameter from the cast and then applies its own
 * json encoder, so handing it `JSON.stringify(x)` stores the STRING. Its own
 * wrapper serialises once. The workflow fixture lost an afternoon to this.
 */
const json = (value: unknown) => raw.json(value as Parameters<postgres.Sql["json"]>[0]);

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Re-resolve after changing the membership, the way the next request would. */
const actorFor = async (token: string) =>
  (await resolveSession(db(), hashOf(token)))!.actor;

run("the actor a signed in technician gets", () => {
  it("carries the technician record the membership points at", async () => {
    const session = await resolveSession(db(), hashOf(techToken));
    expect(session).not.toBeNull();
    // Without this the technician scope resolves to "own" and then matches
    // nothing, because there is no technician to compare against.
    expect(session!.actor.technicianId).toBeTruthy();
  });

  it("sees the job assigned to them", async () => {
    const session = await resolveSession(db(), hashOf(techToken));
    const result = await jobs.list({ actor: session!.actor, db: db() }, { limit: 50 });
    const ids = result.data.map((j) => j.id);
    expect(ids).toContain(mineId);
  });

  it("does not see the job assigned to somebody else", async () => {
    const session = await resolveSession(db(), hashOf(techToken));
    const result = await jobs.list({ actor: session!.actor, db: db() }, { limit: 50 });
    expect(result.data.map((j) => j.id)).not.toContain(theirsId);
  });
});

run("a crew lead", () => {
  it("carries the crews they are a member of", async () => {
    const [crew] = await raw<{ id: string }[]>`
      insert into public.crew (organization_id, name) values (${ORG}, 'Crew One') returning id`;
    const [t] = await raw<{ id: string }[]>`
      select t.id from public.technician t
      join public.membership m on m.id = t.membership_id
      where m.user_id = ${TECH_USER}`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id)
              values (${ORG}, ${crew!.id}, ${t!.id}) on conflict do nothing`;

    // Without this the `crew` scope compares against an empty list and
    // matches nothing, which is how `crew_lead` behaved for everyone.
    expect((await actorFor(techToken)).crewIds).toContain(crew!.id);
  });
});

run("a scope override on the membership", () => {
  it("reaches the query and narrows what a dispatcher reads", async () => {
    // A dispatcher reads every job. This one is restricted to their own, and
    // the restriction has to survive the trip through the session.
    await raw`update public.membership set role = 'dispatcher',
                scope_overrides = ${json({ job: "own" })}
              where user_id = ${TECH_USER} and organization_id = ${ORG}`;

    const actor = await actorFor(techToken);
    expect(actor.scopeOverrides).toMatchObject({ job: "own" });

    const result = await jobs.list({ actor, db: db() }, { limit: 50 });
    const ids = result.data.map((j) => j.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(theirsId);
  });

  it("drops a value the scope ladder does not know rather than trusting it", async () => {
    // A jsonb column holds anything, including a typo and including whatever
    // a future migration leaves behind. An unrecognised scope must not be
    // compared against the ladder and treated as the widest thing that is not
    // narrower.
    await raw`update public.membership set scope_overrides = ${json({ job: "everything" })}
              where user_id = ${TECH_USER} and organization_id = ${ORG}`;
    const actor = await actorFor(techToken);
    expect(actor.scopeOverrides?.job).toBeUndefined();
  });

  it("restores the dispatcher's full view once the override is removed", async () => {
    await raw`update public.membership set scope_overrides = '{}'::jsonb
              where user_id = ${TECH_USER} and organization_id = ${ORG}`;
    const result = await jobs.list({ actor: await actorFor(techToken), db: db() }, { limit: 50 });
    expect(result.data.map((j) => j.id)).toContain(theirsId);
  });
});

run("a custom role", () => {
  let roleId = "";

  it("cannot contain a permission its author does not hold", async () => {
    // The whole reason `role:write` is not sufficient on its own: a role is a
    // container for permissions, so anyone who can write one can write
    // `owner` into it.
    // Given `role:write` explicitly, so this isolates the escalation check
    // from the permission check. Holding `role:write` is exactly the state in
    // which the escalation is available, and it is handed out as an
    // administrative convenience.
    const officeManager: ServiceContext = {
      actor: {
        userId: OWNER_USER, organizationId: ORG,
        roles: ["office_manager"] as Actor["roles"],
        grants: ["role:write"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(roles.create(officeManager, {
      name: "Sneaky", permissions: ["payroll:read", "customer:read"],
    })).rejects.toThrow(/payroll:read/);
  });

  it("cannot be scoped wider than its author", async () => {
    const restricted: ServiceContext = {
      actor: {
        userId: OWNER_USER, organizationId: ORG,
        roles: ["technician"] as Actor["roles"],
        grants: ["role:write"] as NonNullable<Actor["grants"]>,
        scopeOverrides: { job: "own" },
      },
      db: db(),
    };
    await expect(roles.create(restricted, {
      name: "Wider", permissions: ["job:read"], scopes: { job: "all" },
    })).rejects.toThrow(/job/);
  });

  it("refuses a permission key that is not in the catalogue", async () => {
    // Dropping it silently would produce a role that looks right in the
    // editor and does less than its author believes.
    await expect(roles.create(owner(), {
      name: "Typo", permissions: ["custmoer:read"],
    })).rejects.toThrow(/Unknown permissions/);
  });

  it("is created by an owner and replaces the preset when assigned", async () => {
    const created = await roles.create(owner(), {
      name: "Branch Manager",
      description: "Runs one branch",
      basedOn: "office_manager",
      permissions: ["job:read", "customer:read"],
      scopes: { job: "own" },
    });
    roleId = created.id;

    const [m] = await raw<{ id: string }[]>`
      select id from public.membership where user_id = ${TECH_USER} and organization_id = ${ORG}`;
    await roles.assign(owner(), { membershipId: m!.id, roleId });

    const actor = await actorFor(techToken);

    /**
     * Asserted on the EFFECTIVE permission set, not on `grants`.
     *
     * The first version of this checked `actor.grants` and passed against a
     * deliberately broken resolver that kept the preset role alongside the
     * custom one, because the preset's permissions arrive through `roles`
     * and never touch `grants`. Checking the input to a resolution proves
     * nothing about the resolution. Same weak-assertion trap as the route
     * matcher and the prototype reader.
     */
    const held = permissionsFor(actor);
    expect(held.has("job:read")).toBe(true);
    expect(held.has("customer:read")).toBe(true);
    // A dispatcher can dispatch. This role says two permissions and is two
    // permissions: a custom role replaces the preset rather than adding to it.
    expect(held.has("visit:write")).toBe(false);
    expect(actor.scopeOverrides).toMatchObject({ job: "own" });
  });

  it("falls back to the preset rather than locking people out when deleted", async () => {
    // A role removed at 4pm must not lock its holders out at 4:01.
    await roles.remove(owner(), { id: roleId });
    const actor = await actorFor(techToken);
    expect(actor.roles).toEqual(["dispatcher"]);
    expect(await jobs.list({ actor, db: db() }, { limit: 50 })).toBeTruthy();
  });
});
